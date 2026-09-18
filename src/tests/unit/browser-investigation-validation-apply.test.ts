// #234 — server-authoritative apply (Vitest, memory).
//
// Applying a proposal loads the persisted server-generated validation record
// and binds it by investigation, proposal, policy, and validation hashes
// before anything is copied into the version. Client-submitted validation
// status and holdout counts/identities are rejected as `validation_untrusted`
// credentials rather than trusted. Stale-hash validation is rejected as
// `stale_proposal`, never silently inherited. Blocked-draft, inactive, and
// no-image-grant semantics are unchanged.

import { describe, expect, it } from 'vitest';
import { hashCanonicalJson } from '../../shared/stable-id';
import {
  INVESTIGATION_RESULT_VERSION,
  type InvestigationRecord,
} from '../../shared/schemas/browser-investigation';
import {
  hashPolicyContent,
  hashProposal,
  POLICY_FIELDS,
} from '../../shared/schemas/browser-investigation-policy';
import {
  applyProposalToDraft,
  compileProposalForInvestigation,
  createMemoryProposalStore,
  type DraftVersionCreator,
} from '../../onboarding/browser-investigation/apply';
import {
  createMemoryValidationStore,
  validateProposal,
  type PolicyWorkerRunner,
  type ProposalValidation,
} from '../../onboarding/browser-investigation/validate';
import { memoryInvestigationsFor } from './helpers/browser-investigation-memory-store';

const WS = 'ws-apply-binding';
const DOMAIN = 'shop.example.com';
const REP = 'https://shop.example.com/products/alpha';
const HOLDOUT = 'https://shop.example.com/products/holdout-1';

function shopifyResult() {
  return {
    version: INVESTIGATION_RESULT_VERSION,
    summary: 'Apply-binding fixture. Untrusted proposal evidence only.',
    observations: [
      {
        kind: 'shopify_json_observation',
        sourceUrl: REP,
        artifactHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
        incomplete: false,
      },
    ],
    evidenceRefs: [],
    gaps: [],
    renderedBrowserRequired: false,
    platform: 'shopify',
    incompatibleStructureIds: [],
    structures: [{ id: 'shopify-default', sampleUrls: [REP] }],
    fieldRecommendations: POLICY_FIELDS.map((field) => ({
      field,
      sources: ['shopify_product_json'],
      structureId: 'shopify-default',
    })),
    identityRequirements: {
      productIdentity: ['gtin_exact'],
      variantIdentity: ['gtin_exact', 'sku_exact', 'platform_id_exact', 'options_exact_tuple', 'operator_selected'],
      optionAxes: [],
    },
  };
}

function completedRecord(): InvestigationRecord {
  const result = shopifyResult();
  return {
    id: 'binv_binding_1',
    workspaceId: WS,
    domain: DOMAIN,
    mode: 'domain_onboarding',
    status: 'completed',
    provider: 'fake',
    runId: 'binvrun_binding_1',
    requestedModel: null,
    actualModel: null,
    inputSnapshot: {
      domain: DOMAIN,
      mode: 'domain_onboarding',
      sampleUrls: [REP],
      budget: { maxPages: 5, maxReads: 20, maxModelCalls: 8, timeoutMs: 600000 },
      modelPolicy: { allowCloudTextAnalysis: false, allowImageSharing: false },
      knownContext: {},
      requestedAt: '2026-09-17T00:00:00.000Z',
    },
    inputHash: 'input-hash-binding-1-input-hash-binding-1',
    budget: { maxPages: 5, maxReads: 20, maxModelCalls: 8, timeoutMs: 600000 },
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:01.000Z',
    startedAt: null,
    completedAt: '2026-09-17T00:00:01.000Z',
    usage: null,
    failureCode: null,
    failureDetail: null,
    result: result as InvestigationRecord['result'],
    resultHash: hashCanonicalJson(result),
    discardedAt: null,
    discardActor: null,
  } as InvestigationRecord;
}

function passingRunner(): PolicyWorkerRunner {
  return {
    run: async ({ expected }) => ({
      ok: true,
      data: {
        title: expected.name,
        brand: expected.brandHint ?? 'ShopBrand',
        description: 'Deterministic binding-run extraction.',
        price: expected.price ?? '$9.99',
        primaryImage: 'https://shop.example.com/images/alpha.jpg',
        additionalImages: [],
        customFields: {
          sku: expected.sku ?? 'SKU-ALPHA',
          gtin: '810001234501',
          variants: 'Default',
          availability: 'in_stock',
        },
        fieldProvenance: {},
      },
      matrixDecision: { status: 'match', selectedVariantKey: 'shopify:111:Default' },
      selectedReceipt: { selectedVariantKey: 'shopify:111:Default' },
      parentProductId: '999001',
      sourceContentHash: 'binding-content-hash',
    }),
  };
}

function setup() {
  const record = completedRecord();
  const created: Array<Record<string, unknown>> = [];
  const creator: DraftVersionCreator = {
    createVersion: (input) => {
      created.push(input as unknown as Record<string, unknown>);
      return { id: 'ver_t4_1', domain: input.domain, version: 1 };
    },
  };
  const validations = createMemoryValidationStore();
  const deps = {
    investigations: memoryInvestigationsFor(record),
    proposals: createMemoryProposalStore(),
    validations,
    createVersion: creator.createVersion,
  };
  return { record, created, deps, validations };
}

async function honestValidation(
  deps: ReturnType<typeof setup>['deps'],
  record: InvestigationRecord,
): Promise<ProposalValidation> {
  return validateProposal(
    {
      investigations: deps.investigations,
      proposals: deps.proposals,
      validations: deps.validations,
      runner: passingRunner(),
    },
    {
      workspaceId: WS,
      investigationId: record.id,
      samples: [
        { url: REP, role: 'representative', expected: { name: 'Alpha' } },
        { url: HOLDOUT, role: 'holdout', expected: { name: 'Holdout' } },
      ],
    },
  );
}

function seedStaleValidation(
  deps: ReturnType<typeof setup>['deps'],
  record: InvestigationRecord,
  overrides: { proposalHash?: string; policyHash?: string },
): void {
  const body = {
    investigationId: record.id,
    domain: record.domain,
    status: 'passed',
    proposalHash: overrides.proposalHash ?? 'f'.repeat(64),
    policyHash: overrides.policyHash ?? '0'.repeat(64),
    baselineVersionId: null,
    samples: [],
    holdouts: { required: 1, passed: 1, sampleIds: [HOLDOUT] },
    blockers: [],
  } as const;
  const validationHash = hashCanonicalJson(body);
  const validation = {
    ...body,
    validationId: `vval_${validationHash.slice(0, 16)}`,
    validatedAt: new Date().toISOString(),
    validationHash,
  };
  deps.validations.saveValidation(WS, record.id, JSON.stringify(validation), validationHash, body.policyHash, validation.validatedAt);
}

describe('server-authoritative apply (#234)', () => {
  it('honest apply with fresh persisted validation succeeds and preserves the trusted result', async () => {
    const { record, created, deps } = setup();
    const validation = await honestValidation(deps, record);
    expect(validation.status).toBe('passed');

    const applied = await applyProposalToDraft(deps, {
      workspaceId: WS,
      investigationId: record.id,
      actor: 'operator-1',
    });

    expect(applied.proposalHash).toBe(validation.proposalHash);
    expect(applied.policyHash).toBe(validation.policyHash);
    const summary = created[0].validationSummary as Record<string, unknown>;
    expect(summary.investigationDerived).toBe(true);
    expect(summary.validationStatus).toBe('passed');
    expect(summary.holdoutPassedCount).toBe(1);
    expect(summary.holdouts).toEqual({ required: 1, passed: 1, sampleIds: [HOLDOUT] });
    expect(summary.validationRef).toBe(validation.validationId);
    expect(summary.validationHash).toBe(validation.validationHash);
    expect(summary.proposalHash).toBe(validation.proposalHash);
    expect(summary.policyHash).toBe(validation.policyHash);
    expect(summary.imageRuleOk).toBe(false);
  });

  it('forged passed validation with no matching persisted record is rejected', async () => {
    const { record, created, deps } = setup();
    await expect(
      applyProposalToDraft(deps, {
        workspaceId: WS,
        investigationId: record.id,
        actor: 'operator-1',
        validation: {
          status: 'passed',
          policyHash: '0'.repeat(64),
          holdouts: { passed: 1, required: 1, sampleIds: [HOLDOUT] },
        },
      }),
    ).rejects.toThrow(/validation_untrusted/);
    expect(created).toEqual([]);
  });

  it('smuggled top-level status/holdout credentials are rejected', async () => {
    const { record, created, deps } = setup();
    await expect(
      applyProposalToDraft(deps, {
        workspaceId: WS,
        investigationId: record.id,
        actor: 'operator-1',
        ...({ status: 'passed' } as unknown as Record<string, unknown>),
      } as Parameters<typeof applyProposalToDraft>[1]),
    ).rejects.toThrow(/validation_untrusted/);
    await expect(
      applyProposalToDraft(deps, {
        workspaceId: WS,
        investigationId: record.id,
        actor: 'operator-1',
        ...({ holdouts: { passed: 1, required: 1, sampleIds: [HOLDOUT] } } as unknown as Record<string, unknown>),
      } as Parameters<typeof applyProposalToDraft>[1]),
    ).rejects.toThrow(/validation_untrusted/);
    expect(created).toEqual([]);
  });

  it('stale-hash validation (policy edited after validation) is rejected, never inherited', async () => {
    const { record, created, deps } = setup();
    seedStaleValidation(deps, record, { policyHash: '0'.repeat(64) });
    await expect(
      applyProposalToDraft(deps, { workspaceId: WS, investigationId: record.id, actor: 'operator-1' }),
    ).rejects.toThrow(/stale_proposal/);
    expect(created).toEqual([]);
  });

  it('tampered persisted validation (hash mismatch) is rejected as untrusted', async () => {
    const { record, created, deps } = setup();
    const validation = await honestValidation(deps, record);
    // Tamper the stored hash binding without updating the JSON: integrity must fail closed.
    deps.validations.saveValidation(
      WS,
      record.id,
      JSON.stringify(validation),
      '1'.repeat(64),
      validation.policyHash,
      validation.validatedAt,
    );
    await expect(
      applyProposalToDraft(deps, { workspaceId: WS, investigationId: record.id, actor: 'operator-1' }),
    ).rejects.toThrow(/validation_untrusted/);
    expect(created).toEqual([]);
  });

  it('records zero holdout evidence when no persisted validation exists', async () => {
    const { record, created, deps } = setup();
    await applyProposalToDraft(deps, { workspaceId: WS, investigationId: record.id, actor: 'operator-1' });
    const summary = created[0].validationSummary as Record<string, unknown>;
    expect(summary.validationStatus).toBe('not_run');
    expect(summary.holdoutPassedCount).toBe(0);
    expect(summary.imageRuleOk).toBe(false);
  });

  it('current proposal/policy hashes bind the honest record (no silent drift)', async () => {
    const { record, deps } = setup();
    const validation = await honestValidation(deps, record);
    const outcome = await compileProposalForInvestigation(
      { investigations: deps.investigations, proposals: deps.proposals },
      WS,
      record.id,
    );
    if (outcome.status !== 'proposal') throw new Error('fixture must compile');
    expect(validation.proposalHash).toBe(hashProposal(outcome.proposal));
    expect(validation.policyHash).toBe(
      hashPolicyContent({
        platform: outcome.proposal.platform,
        structures: outcome.proposal.structures,
        fields: outcome.proposal.fields,
        identity: outcome.proposal.identity,
        renderedBrowserRequired: outcome.proposal.renderedBrowserRequired,
      }),
    );
  });
});
