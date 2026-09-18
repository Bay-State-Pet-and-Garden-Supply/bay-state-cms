// T4 (#228) — validation binding on the blocked-draft apply path (Vitest, memory).
//
// A validation reference is bound to the exact policy content it was
// computed against: a mismatched policyHash rejects the apply as stale
// instead of replaying validation onto edited content. Blind-holdout
// evidence is preserved into the draft validation summary for the
// non-waivable health bar. Saving still implies no approval, health,
// activation, release, or image attestation.

import { describe, expect, it } from 'vitest';
import { hashCanonicalJson } from '../../shared/stable-id';
import {
  INVESTIGATION_RESULT_VERSION,
  type InvestigationRecord,
} from '../../shared/schemas/browser-investigation';
import { POLICY_FIELDS } from '../../shared/schemas/browser-investigation-policy';
import {
  applyProposalToDraft,
  compileProposalForInvestigation,
  createMemoryProposalStore,
  type DraftVersionCreator,
} from '../../onboarding/browser-investigation/apply';
import { memoryInvestigationsFor } from './helpers/browser-investigation-memory-store';

const WS = 'ws-apply-binding';
const DOMAIN = 'shop.example.com';

function shopifyResult() {
  return {
    version: INVESTIGATION_RESULT_VERSION,
    summary: 'Apply-binding fixture. Untrusted proposal evidence only.',
    observations: [
      {
        kind: 'shopify_json_observation',
        sourceUrl: 'https://shop.example.com/products/alpha',
        artifactHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
        incomplete: false,
      },
    ],
    evidenceRefs: [],
    gaps: [],
    renderedBrowserRequired: false,
    platform: 'shopify',
    incompatibleStructureIds: [],
    structures: [{ id: 'shopify-default', sampleUrls: ['https://shop.example.com/products/alpha'] }],
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
      sampleUrls: ['https://shop.example.com/products/alpha'],
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

function setup() {
  const record = completedRecord();
  const created: Array<Record<string, unknown>> = [];
  const creator: DraftVersionCreator = {
    createVersion: (input) => {
      created.push(input as unknown as Record<string, unknown>);
      return { id: 'ver_t4_1', domain: input.domain, version: 1 };
    },
  };
  const deps = {
    investigations: memoryInvestigationsFor(record),
    proposals: createMemoryProposalStore(),
    createVersion: creator.createVersion,
  };
  return { record, created, deps };
}

async function currentPolicyHash(record: InvestigationRecord, deps: ReturnType<typeof setup>['deps']): Promise<string> {
  const outcome = await compileProposalForInvestigation(
    { investigations: deps.investigations, proposals: deps.proposals },
    WS,
    record.id,
  );
  if (outcome.status !== 'proposal') throw new Error('fixture must compile');
  const { hashPolicyContent } = await import('../../shared/schemas/browser-investigation-policy');
  return hashPolicyContent({
    platform: outcome.proposal.platform,
    structures: outcome.proposal.structures,
    fields: outcome.proposal.fields,
    identity: outcome.proposal.identity,
    renderedBrowserRequired: outcome.proposal.renderedBrowserRequired,
  });
}

describe('apply validation binding (T4)', () => {
  it('preserves holdout evidence and validation status into the blocked draft', async () => {
    const { record, created, deps } = setup();
    const policyHash = await currentPolicyHash(record, deps);
    const applied = await applyProposalToDraft(deps, {
      workspaceId: WS,
      investigationId: record.id,
      actor: 'operator-1',
      validation: {
        status: 'passed',
        validationRef: 'vval_abc123',
        policyHash,
        holdouts: { passed: 1, required: 1, sampleIds: ['https://shop.example.com/products/holdout-1'] },
      },
    });
    expect(applied.policyHash).toBe(policyHash);
    const summary = created[0].validationSummary as Record<string, unknown>;
    expect(summary.investigationDerived).toBe(true);
    expect(summary.validationStatus).toBe('passed');
    expect(summary.holdoutPassedCount).toBe(1);
    expect(summary.holdouts).toEqual({ required: 1, passed: 1, sampleIds: ['https://shop.example.com/products/holdout-1'] });
    expect(summary.imageRuleOk).toBe(false);
  });

  it('rejects validation computed against different policy content as stale', async () => {
    const { record, created, deps } = setup();
    await expect(
      applyProposalToDraft(deps, {
        workspaceId: WS,
        investigationId: record.id,
        actor: 'operator-1',
        validation: { status: 'passed', policyHash: '0'.repeat(64), holdouts: { passed: 1, required: 1, sampleIds: [] } },
      }),
    ).rejects.toThrow(/stale_proposal/);
    expect(created).toEqual([]);
  });

  it('records zero holdout evidence when no validation is supplied', async () => {
    const { record, created, deps } = setup();
    await applyProposalToDraft(deps, { workspaceId: WS, investigationId: record.id, actor: 'operator-1' });
    const summary = created[0].validationSummary as Record<string, unknown>;
    expect(summary.validationStatus).toBe('not_run');
    expect(summary.holdoutPassedCount).toBe(0);
  });
});
