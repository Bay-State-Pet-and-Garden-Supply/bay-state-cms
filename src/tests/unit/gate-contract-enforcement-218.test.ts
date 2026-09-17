// Issue #218 — gate contract enforcement: the reviewed-health gate fails
// closed on missing image attestation, empty expected-hash sets, and
// missing title / empty results. Pure `evaluateGate` assertions (vitest,
// no DB) — each weakened check has a test proving it now fails closed.
import { describe, it, expect } from 'vitest';
import { evaluateGate } from '../../onboarding/profile-activation-gate';
import { VARIANT_INELIGIBILITY_REASON_PREFIX, variantIdentityEligibilityForItem } from '../../onboarding/variant-identity-eligibility';
import { titleMatrixFixture } from './helpers/gate-matrix-fixture';

function healthyInput() {
  const m = titleMatrixFixture('gate-218.example.com', ['s1', 's2', 's3'], ['h1', 'h2', 'h3']);
  return {
    requiredResults: [
      { field: 'title', success: true },
      { field: 'title', success: true },
      { field: 'title', success: true },
    ],
    wrongProduct: false,
    wrongVariant: false,
    waiver: false,
    confirmedCount: 3,
    imageRuleOk: true as const,
    matrixResult: m,
    expectedArtifactHashes: ['h1', 'h2', 'h3'],
    sampleIds: ['s1', 's2', 's3'],
  };
}

describe('gate contract enforcement (#218)', () => {
  it('fails closed when image attestation is missing (undefined)', async () => {
    const input: any = { ...healthyInput(), imageRuleOk: undefined };
    const r = evaluateGate(input);
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toMatch(/missing_image_attestation/);
  });

  it('still fails closed when the image rule explicitly failed', async () => {
    const input: any = { ...healthyInput(), imageRuleOk: false };
    const r = evaluateGate(input);
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toMatch(/image/);
  });

  it('fails closed on empty expected-hash sets instead of skipping comparison', async () => {
    const input: any = { ...healthyInput(), expectedArtifactHashes: [] };
    const r = evaluateGate(input);
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toMatch(/missing_expected_hashes/);
  });

  it('fails closed when no successful title result is present', async () => {
    const input: any = {
      ...healthyInput(),
      requiredResults: [{ field: 'brand', success: true }],
    };
    const r = evaluateGate(input);
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toMatch(/missing_title/);
  });

  it('fails closed on empty required results', async () => {
    const input: any = { ...healthyInput(), requiredResults: [] };
    const r = evaluateGate(input);
    expect(r.allowed).toBe(false);
    expect(r.blockReason).toMatch(/missing_results/);
  });

  it('still allows the fully-evidenced happy pass', async () => {
    const r = evaluateGate(healthyInput());
    expect(r.allowed).toBe(true);
  });
});

describe('variant-identity eligibility predicate (#218)', () => {
  it('holds variant-gate-parked items even with no resolution row (Sitecore no-matrix case)', () => {
    const r = variantIdentityEligibilityForItem({
      itemId: 'item-1',
      errorMessage: 'variant:variant_selection_required: family page cannot prove single-variant',
      variantResolution: null,
    });
    expect(r.eligible).toBe(false);
    expect(r.reason.startsWith(VARIANT_INELIGIBILITY_REASON_PREFIX)).toBe(true);
  });

  it('holds ambiguous / stale / unsupported resolutions', () => {
    for (const status of ['ambiguous', 'no_match', 'stale', 'unsupported', 'too_many_variants']) {
      const r = variantIdentityEligibilityForItem({
        itemId: 'item-1',
        errorMessage: 'No extractor profile for x — profile required',
        variantResolution: { status, selected_variant_key: null, automatic_variant_key: null },
      });
      expect(r.eligible).toBe(false);
      expect(r.reason.startsWith(VARIANT_INELIGIBILITY_REASON_PREFIX)).toBe(true);
    }
  });

  it('releases operator-selected and automatically-resolved identities', () => {
    expect(variantIdentityEligibilityForItem({
      itemId: 'item-1',
      errorMessage: 'No extractor profile for x — profile required',
      variantResolution: { status: 'selected', selected_variant_key: 'size-s', automatic_variant_key: null },
    }).eligible).toBe(true);
    expect(variantIdentityEligibilityForItem({
      itemId: 'item-1',
      errorMessage: 'No extractor profile for x — profile required',
      variantResolution: { status: 'resolved', selected_variant_key: null, automatic_variant_key: 'size-s' },
    }).eligible).toBe(true);
  });

  it('holds resolved/selected rows that carry no variant key', () => {
    expect(variantIdentityEligibilityForItem({
      itemId: 'item-1',
      errorMessage: null,
      variantResolution: { status: 'selected', selected_variant_key: null, automatic_variant_key: null },
    }).eligible).toBe(false);
  });

  it('leaves single-variant items with no variant signal eligible', () => {
    const r = variantIdentityEligibilityForItem({
      itemId: 'item-1',
      errorMessage: 'No extractor profile for x — profile required',
      variantResolution: null,
    });
    expect(r.eligible).toBe(true);
  });
});
