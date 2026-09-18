// T6 (#230) — drift repair proposes the smallest supported deterministic
// change (Vitest, pure).
//
// - Frozen last-healthy baseline vs fresh proposal → field-level diff only;
//   unchanged baseline fields are preserved, never reinvented.
// - Platform shifts and missing baselines become full_replacement (honest,
//   still requires validation) — never a silent minimal patch.
// - requires_code_adapter / unresolved outcomes become unrepairable with no
//   automatic rerun and no auto-promotion.
// - No provider calls, no store writes: pure derivation over stored state.

import { describe, expect, it } from 'vitest';
import { hashCanonicalJson } from '../../shared/stable-id';
import { INVESTIGATION_RESULT_VERSION } from '../../shared/schemas/browser-investigation';
import {
  POLICY_FIELDS,
  type ExtractionPolicyProposal,
} from '../../shared/schemas/browser-investigation-policy';
import { compileInvestigationResult } from '../../onboarding/browser-investigation/compiler';
import { proposeDriftRepair } from '../../onboarding/browser-investigation/drift';

const DOMAIN = 'shop.example.com';

function shopifyResultWith(selectorForPrice?: string) {
  return {
    version: INVESTIGATION_RESULT_VERSION,
    summary: 'Drift fixture. Untrusted proposal evidence only.',
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
      ...(field === 'price' && selectorForPrice ? { sources: ['shopify_product_json', 'selector'], selector: selectorForPrice } : {}),
    })),
    identityRequirements: {
      productIdentity: ['gtin_exact'],
      variantIdentity: ['gtin_exact', 'sku_exact', 'platform_id_exact', 'options_exact_tuple', 'operator_selected'],
      optionAxes: [],
    },
  } as const;
}

function compileProposal(selectorForPrice?: string) {
  const result = shopifyResultWith(selectorForPrice);
  const outcome = compileInvestigationResult(result as never, {
    domain: DOMAIN,
    investigationId: 'binv_drift_1',
    runId: 'binvrun_drift_1',
    inputHash: 'input-hash-drift-1-input-hash-drift-1-input',
    resultHash: hashCanonicalJson(result),
  });
  if (outcome.status !== 'proposal') throw new Error('drift fixture must compile');
  return outcome;
}

function baselinePolicyOf(proposal: ExtractionPolicyProposal) {
  return {
    version: proposal.version,
    platform: proposal.platform,
    structures: proposal.structures,
    fields: proposal.fields,
    identity: proposal.identity,
    renderedBrowserRequired: proposal.renderedBrowserRequired,
  };
}

describe('drift repair smallest-change proposal (T6)', () => {
  it('identical baseline and proposal yields no_change with no rerun or promotion', () => {
    const outcome = compileProposal();
    const baseline = baselinePolicyOf(outcome.proposal);
    const repair = proposeDriftRepair({
      baselinePolicy: baseline,
      outcome,
      affectedFields: ['price'],
      failureCodes: ['field_missing:price'],
    });
    expect(repair.status).toBe('no_change');
    expect(repair.changedFields).toEqual([]);
    expect(repair.unchangedFields.length).toBe(outcome.proposal.fields.length);
    expect(repair.requiresValidation).toBe(true);
    expect(repair.automaticRerun).toBe(false);
    expect(repair.automaticPromotion).toBe(false);
    expect(repair.affectedFields).toEqual(['price']);
    expect(repair.failureCodes).toEqual(['field_missing:price']);
  });

  it('one changed selector yields minimal_change touching only that field', () => {
    const before = compileProposal();
    const after = compileProposal('.price--sale');
    const repair = proposeDriftRepair({
      baselinePolicy: baselinePolicyOf(before.proposal),
      outcome: after,
      affectedFields: ['price'],
      failureCodes: ['selector_rejected'],
    });
    expect(repair.status).toBe('minimal_change');
    expect(repair.changedFields.map((c) => c.field)).toEqual(['price']);
    expect(repair.unchangedFields).not.toContain('price');
    expect(repair.unchangedFields.length).toBe(before.proposal.fields.length - 1);
    expect(repair.baselinePolicyHash).not.toBe(repair.proposalPolicyHash);
    expect(repair.blockers).toContain('validation:not_run');
  });

  it('missing baseline becomes full_replacement, still gated on validation', () => {
    const outcome = compileProposal();
    const repair = proposeDriftRepair({ baselinePolicy: null, outcome });
    expect(repair.status).toBe('full_replacement');
    expect(repair.changedFields.length).toBe(outcome.proposal.fields.length);
    expect(repair.requiresValidation).toBe(true);
    expect(repair.automaticPromotion).toBe(false);
    expect(repair.blockers.some((b) => b.startsWith('baseline_missing'))).toBe(true);
  });

  it('platform shifts become full_replacement, never a silent minimal patch', () => {
    const outcome = compileProposal();
    const baseline = { ...baselinePolicyOf(outcome.proposal), platform: 'woocommerce' };
    const repair = proposeDriftRepair({ baselinePolicy: baseline, outcome });
    expect(repair.status).toBe('full_replacement');
    expect(repair.blockers.some((b) => b.startsWith('platform_changed'))).toBe(true);
    expect(repair.automaticRerun).toBe(false);
  });

  it('requires_code_adapter and unresolved outcomes are unrepairable with no rerun', () => {
    const adapterOutcome = {
      status: 'requires_code_adapter' as const,
      codeAdapterRequest: {
        summary: 'needs coded adapter',
        capability: 'click_variant_options',
        reason: 'interaction-only variant selection has no supported primitive',
        evidenceRefs: [],
        structureIds: [],
      },
    };
    const unrepairable = proposeDriftRepair({ baselinePolicy: null, outcome: adapterOutcome });
    expect(unrepairable.status).toBe('unrepairable');
    expect(unrepairable.automaticRerun).toBe(false);
    expect(unrepairable.automaticPromotion).toBe(false);
    expect(unrepairable.requiresValidation).toBe(true);

    const unresolvedOutcome = {
      status: 'unresolved' as const,
      gaps: [{ kind: 'incompatible_structures' as const, detail: 'two templates, one policy' }],
    };
    const unresolved = proposeDriftRepair({ baselinePolicy: null, outcome: unresolvedOutcome });
    expect(unresolved.status).toBe('unrepairable');
    expect(unresolved.automaticRerun).toBe(false);
  });

  it('structure-only drift is minimal_change, never a false no_change', () => {
    const outcome = compileProposal();
    const baseline = baselinePolicyOf(outcome.proposal);
    const driftedBaseline = {
      ...baseline,
      structures: [{ id: 'shopify-split-template', sampleUrls: ['https://shop.example.com/products/alpha'] }],
    };
    const repair = proposeDriftRepair({ baselinePolicy: driftedBaseline, outcome });
    expect(repair.status).toBe('minimal_change');
    expect(repair.changedFields).toEqual([]);
    expect(repair.nonFieldChanges).toContain('structures');
    expect(repair.blockers.some((b) => b.startsWith('non_field_drift:structures'))).toBe(true);
    expect(repair.automaticRerun).toBe(false);
    expect(repair.automaticPromotion).toBe(false);
  });

  it('identity and rendered-browser drift surface as non-field changes', () => {
    const outcome = compileProposal();
    const baseline = baselinePolicyOf(outcome.proposal);
    const identityDrift = proposeDriftRepair({
      baselinePolicy: { ...baseline, identity: { productIdentity: ['sku_exact'], variantIdentity: ['sku_exact'], optionAxes: [] } },
      outcome,
    });
    expect(identityDrift.status).toBe('minimal_change');
    expect(identityDrift.nonFieldChanges).toContain('identity');

    const renderedDrift = proposeDriftRepair({
      baselinePolicy: { ...baseline, renderedBrowserRequired: !outcome.proposal.renderedBrowserRequired },
      outcome,
    });
    expect(renderedDrift.status).toBe('minimal_change');
    expect(renderedDrift.nonFieldChanges).toContain('renderedBrowserRequired');
  });
});
