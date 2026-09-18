// Contract test (deterministic fake provider) — NOT the acceptance proof.
// The acceptance proof is the opt-in real thin-slice pilot against a live
// Shopify domain (docs/plans/browser-investigation-pilot.md, #239), which runs
// the real containerized harness through the production worker with a truly
// blind holdout. This suite retains fast deterministic coverage of the
// thin-slice contract (request → investigation → compile → validate →
// governed draft) via explicit fake-provider injection only (never reachable
// from production launches since #235).
//
// Explicit operator request → bounded investigation (deterministic fake
// stand-in for the isolated local harness) → Shopify policy compilation →
// production-worker representative + blind-holdout validation → visible
// governed draft (sanitized inactive draft with blockers preserved).
//
// Records the mandatory negative invariant in the same run: validation and
// apply make zero investigation-provider calls; only the explicit
// investigate path dispatches. No activation, release, or image attestation
// is performed or claimed — the draft stays inactive with imageRuleOk false.

import { describe, expect, it } from 'vitest';
import {
  FakeInvestigationProvider,
} from '../../onboarding/browser-investigation/fake-provider';
import {
  getInvestigationProviderCallCount,
  registerInvestigationProvider,
  resetInvestigationProviderCalls,
} from '../../onboarding/browser-investigation/provider';
import {
  requestAndRunInvestigation,
} from '../../onboarding/browser-investigation/service';
import {
  applyProposalToDraft,
  compileProposalForInvestigation,
  createMemoryProposalStore,
} from '../../onboarding/browser-investigation/apply';
import {
  createMemoryValidationStore,
  validateProposal,
  type PolicyWorkerRunner,
} from '../../onboarding/browser-investigation/validate';
import { describeInvestigationWorkspace } from '../../onboarding/browser-investigation/workspace';
import { describeInvestigationTelemetry } from '../../onboarding/browser-investigation/telemetry';
import { proposeDriftRepair } from '../../onboarding/browser-investigation/drift';
import { extractionPolicyOfSelectors } from '../../shared/schemas/browser-investigation-policy';
import { createMemoryInvestigationStore } from './helpers/browser-investigation-memory-store';

const WS = 'ws-t6-thin-slice';
const DOMAIN = 'shop.example.com';
const REP_A = 'https://shop.example.com/products/alpha';
const REP_B = 'https://shop.example.com/products/beta';
const HOLDOUT = 'https://shop.example.com/products/holdout-1';

function passingRunner(): PolicyWorkerRunner {
  return {
    run: async ({ expected }) => ({
      ok: true,
      data: {
        title: expected.name,
        brand: expected.brandHint ?? 'BetterBone',
        description: 'Deterministic thin-slice extraction.',
        price: expected.price ?? '$12.99',
        primaryImage: 'https://shop.example.com/images/alpha.jpg',
        additionalImages: [],
        customFields: {
          sku: expected.sku ?? 'BB-ALPHA',
          gtin: '810001234501',
          variants: 'Small',
          availability: 'in_stock',
        },
        fieldProvenance: {},
      },
      matrixDecision: { status: 'match', selectedVariantKey: 'shopify:111:Small' },
      selectedReceipt: { selectedVariantKey: 'shopify:111:Small' },
      parentProductId: '999001',
      sourceContentHash: 'thin-slice-content-hash',
    }),
  };
}

describe('thin slice contract (fake provider; NOT the acceptance pilot — see browser-investigation-pilot.md) (T6)', () => {
  it('delivers a visible governed draft with zero non-explicit provider calls', async () => {
    const investigations = createMemoryInvestigationStore();
    const proposals = createMemoryProposalStore();
    const validations = createMemoryValidationStore();

    // Negative invariant, part 1: no provider calls before the explicit request.
    resetInvestigationProviderCalls();
    expect(getInvestigationProviderCallCount()).toBe(0);

    // Explicit operator request through the bounded investigation seam.
    const fake = new FakeInvestigationProvider();
    fake.setScenario('valid');
    registerInvestigationProvider(fake);
    resetInvestigationProviderCalls();
    // Deterministic contract double: the fake is explicit test injection
    // only (never reachable from production launches since #235).
    const record = await requestAndRunInvestigation(investigations, {
      workspaceId: WS,
      domain: DOMAIN,
      mode: 'domain_onboarding',
      sampleUrls: [REP_A, REP_B],
      provider: 'fake',
    });
    expect(record.status).toBe('completed');
    expect(record.result?.platform).toBe('shopify');
    const callsAfterInvestigation = getInvestigationProviderCallCount();
    expect(callsAfterInvestigation).toBeGreaterThan(0);

    // Deterministic compilation to a Shopify policy proposal.
    const outcome = await compileProposalForInvestigation(
      { investigations, proposals },
      WS,
      record.id,
    );
    expect(outcome.status).toBe('proposal');
    if (outcome.status !== 'proposal') throw new Error('thin-slice fixture must compile');
    expect(outcome.proposal.platform).toBe('shopify');

    // Representative + blind-holdout validation through the worker seam.
    const validation = await validateProposal(
      { investigations, proposals, validations, runner: passingRunner() },
      {
        workspaceId: WS,
        investigationId: record.id,
        samples: [
          { url: REP_A, role: 'representative', expected: { name: 'BetterBone Alpha', variantKey: 'shopify:111:Small', productId: '999001' } },
          { url: REP_B, role: 'representative', expected: { name: 'BetterBone Beta', variantKey: 'shopify:111:Small', productId: '999001' } },
          { url: HOLDOUT, role: 'holdout', expected: { name: 'BetterBone Holdout', variantKey: 'shopify:111:Small', productId: '999001' } },
        ],
      },
    );
    expect(validation.status).toBe('passed');
    expect(validation.holdouts.passed).toBeGreaterThanOrEqual(1);

    // Negative invariant, part 2: validation made zero provider calls.
    expect(getInvestigationProviderCallCount()).toBe(callsAfterInvestigation);

    // Governed draft (#234 server-authoritative): the persisted validation
    // record is resolved and bound by hashes — no client-submitted status
    // or holdout counts cross the apply boundary.
    const created: Array<Record<string, unknown>> = [];
    const applied = await applyProposalToDraft(
      {
        investigations,
        proposals,
        validations,
        createVersion: (input) => {
          created.push(input as unknown as Record<string, unknown>);
          return { id: 'ver_thin_slice_1', domain: input.domain, version: 1 };
        },
      },
      {
        workspaceId: WS,
        investigationId: record.id,
        actor: 'operator-thin-slice',
      },
    );
    expect(applied.appliedVersionId).toBe('ver_thin_slice_1');
    expect(applied.proposalHash).toBe(validation.proposalHash);
    expect(applied.policyHash).toBe(validation.policyHash);
    expect(getInvestigationProviderCallCount()).toBe(callsAfterInvestigation);

    const draft = created[0]!;
    const summary = draft.validationSummary as Record<string, unknown>;
    expect(summary.imageRuleOk).toBe(false);
    expect(summary.investigationDerived).toBe(true);
    expect(summary.validationStatus).toBe('passed');
    expect(summary.holdoutPassedCount).toBe(validation.holdouts.passed);
    expect(summary.validationRef).toBe(validation.validationId);
    // No activation, release, or attestation performed or claimed.
    expect(draft).not.toHaveProperty('active');
    expect(summary).not.toHaveProperty('released');
    expect(summary).not.toHaveProperty('attested');

    // Visible workspace view + telemetry + drift derivation over stored state.
    const latest = investigations.find(WS, record.id)!;
    const workspace = describeInvestigationWorkspace({
      record: latest,
      budget: latest.budget,
      representatives: [REP_A, REP_B],
      corpusUrls: [REP_A, REP_B, HOLDOUT],
      reservedUrls: validation.holdouts.sampleIds,
      validation,
    });
    expect(workspace.proposal.available).toBe(true);
    expect(workspace.actions.automaticActivation).toBe(false);
    expect(workspace.actions.automaticRelease).toBe(false);

    const telemetry = describeInvestigationTelemetry(latest, validation);
    expect(telemetry.investigationId).toBe(record.id);
    expect(telemetry.validation?.status).toBe('passed');
    expect(telemetry.identitySignals?.matched).toBeGreaterThanOrEqual(1);

    const drift = proposeDriftRepair({
      baselinePolicy: extractionPolicyOfSelectors((draft.selectors as Record<string, unknown>) ?? {}),
      outcome,
    });
    // Fresh proposal matches its own draft content: no change to propose.
    expect(drift.status).toBe('no_change');
    expect(drift.automaticRerun).toBe(false);
    expect(drift.automaticPromotion).toBe(false);
  });
});
