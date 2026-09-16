// Issue #204 — Bonide static structured-data profile tests.
//
// Asserts externally visible behavior at the pre-agreed seams (parent spec
// #197: gates, release eligibility, extraction evidence — never internals):
// the profile v1 selector set is worker-supported syntax with no assumed
// endpoint fetching, worker validation passes on real Bonide product URLs
// with field-by-field gaps enumerated before any draft is considered, the
// three-confirmation count basis holds without waiver, and selective release
// admits only eligible items. No network, no DB — all evidence transcribed.
import { describe, it, expect } from 'vitest';
import {
  BONIDE_204_DOMAIN,
  BONIDE_204_TOTAL_ITEMS,
  BONIDE_204_PROFILE_VERSION,
  BONIDE_204_RELEASE_HEALTH_AUTHORITY,
  BONIDE_204_RUNTIME,
  BONIDE_204_SAMPLES,
  BONIDE_204_SELECTORS,
  FIELD_GAPS_204,
  evaluateActivation204,
  profile204ReferencesNoEndpoints,
  sample204ByUrl,
  selectiveReleaseEligibility204,
} from '../../onboarding/brand-hub/bonide-static-profile-204';
import { verdict201ByDomain } from '../../onboarding/brand-hub/product-page-verdicts-201';
import { isSupportedSelectorSyntax } from '../../shared/selector-utils';

describe('issue #204 profile v1 (acceptance: explicit structured-data selectors, no assumed endpoint fetching)', () => {
  it('targets bonide.com with a static runtime and the five-item scope', () => {
    expect(BONIDE_204_DOMAIN).toBe('bonide.com');
    expect(BONIDE_204_RUNTIME).toBe('static');
    expect(BONIDE_204_TOTAL_ITEMS).toBe(5);
    expect(BONIDE_204_PROFILE_VERSION).toBe(1);
  });

  it('every non-null selector uses worker-supported syntax', () => {
    const selectors = [
      BONIDE_204_SELECTORS.titleSelector,
      BONIDE_204_SELECTORS.brandSelector,
      BONIDE_204_SELECTORS.descriptionSelector,
      BONIDE_204_SELECTORS.imagesSelector,
    ];
    expect(selectors).toHaveLength(4);
    for (const sel of selectors) expect(isSupportedSelectorSyntax(sel)).toBe(true);
  });

  it('references no endpoints: fields come from fetched HTML only (WooCommerce finding reflected in mechanism)', () => {
    expect(profile204ReferencesNoEndpoints()).toBe(true);
    // Structured-data selectors first; exactly one stable CSS selector (h1)
    // where the structured layer has no equivalent; gallery CSS for images.
    expect(BONIDE_204_SELECTORS.brandSelector.startsWith('meta[')).toBe(true);
    expect(BONIDE_204_SELECTORS.descriptionSelector.startsWith('meta[')).toBe(true);
    expect(BONIDE_204_SELECTORS.titleSelector).toBe('h1');
    expect(BONIDE_204_SELECTORS.imagesSelector).toContain('woocommerce-product-gallery');
    expect(BONIDE_204_SELECTORS.priceSelector).toBeNull();
  });

  it('agrees with the #201 input verdict (bonide.com static_profile)', () => {
    expect(verdict201ByDomain('bonide.com')?.verdict).toBe('static_profile');
  });
});

describe('issue #204 worker validation (acceptance: passes on real URLs, gaps enumerated field by field)', () => {
  it('records ten validation samples across the three verdict kinds', () => {
    expect(BONIDE_204_SAMPLES).toHaveLength(10);
    const kinds = new Set(BONIDE_204_SAMPLES.map((s) => s.verdict));
    expect(kinds).toEqual(new Set(['confirmed_clean', 'variant_blocked', 'discontinued_excluded']));
    for (const s of BONIDE_204_SAMPLES) {
      expect(s.url.startsWith('https://bonide.com/product/')).toBe(true);
      expect(s.rationale.length).toBeGreaterThan(80);
    }
  });

  it('three clean confirmations with distinct content hashes and correct product titles', () => {
    const clean = BONIDE_204_SAMPLES.filter((s) => s.verdict === 'confirmed_clean');
    expect(clean.map((s) => s.url).sort()).toEqual([
      'https://bonide.com/product/neem-oil-conc/',
      'https://bonide.com/product/eight-insect-control-garden-dust/',
      'https://bonide.com/product/eight-insect-control-home-garden-rtu/',
    ].sort());
    for (const s of clean) {
      expect(s.ok).toBe(true);
      expect(s.failureCode).toBeNull();
      expect(s.title).toBeTruthy();
      expect(s.title).not.toBe('Discontinued Products');
      expect(s.provenance.title).toBe('profile-selector');
      expect(s.contentHash).toBeTruthy();
    }
    // Distinct pages, not one page counted thrice.
    expect(new Set(clean.map((s) => s.contentHash)).size).toBe(3);
  });

  it('variant-blocked pages fail closed with enumerated 2-candidate matrices (no blind draft)', () => {
    const blocked = BONIDE_204_SAMPLES.filter((s) => s.verdict === 'variant_blocked');
    expect(blocked.map((s) => s.url).sort()).toEqual([
      'https://bonide.com/product/captain-jacks-neem-max-conc/',
      'https://bonide.com/product/pyrethrin-garden-spray-conc/',
      'https://bonide.com/product/sulfur-plant-fungicide-dust/',
    ].sort());
    for (const s of blocked) {
      expect(s.ok).toBe(false);
      expect(s.failureCode).toBe('variant_selection_required');
      expect(s.variantCandidates).toHaveLength(2);
      for (const c of s.variantCandidates!) {
        expect(c.key.startsWith('woocommerce:')).toBe(true);
        expect(c.sku.length).toBeGreaterThan(0);
      }
    }
    expect(sample204ByUrl('https://bonide.com/product/pyrethrin-garden-spray-conc/')?.variantCandidates).toEqual([
      { key: 'woocommerce:74137:8-oz', sku: '857' },
      { key: 'woocommerce:74141:pint', sku: '858' },
    ]);
  });

  it('discontinued slugs are excluded by hash-identity, never counted as confirmations', () => {
    const disco = BONIDE_204_SAMPLES.filter((s) => s.verdict === 'discontinued_excluded');
    expect(disco).toHaveLength(4);
    // One shared discontinued page behind all four slugs.
    expect(new Set(disco.map((s) => s.contentHash)).size).toBe(1);
    for (const s of disco) expect(s.title).toBe('Discontinued Products');
    // And that hash is distinct from every confirmation hash.
    const cleanHashes = new Set(
      BONIDE_204_SAMPLES.filter((s) => s.verdict === 'confirmed_clean').map((s) => s.contentHash),
    );
    for (const s of disco) expect(cleanHashes.has(s.contentHash)).toBe(false);
  });

  it('every required field has a gap entry and no field needs any AI draft', () => {
    expect(FIELD_GAPS_204.map((g) => g.field).sort()).toEqual(
      ['brand', 'description', 'images', 'price', 'title', 'variants'].sort(),
    );
    for (const g of FIELD_GAPS_204) {
      expect(g.draftNeeded).toBe(false);
      expect(g.evidence.length).toBeGreaterThan(80);
    }
    expect(FIELD_GAPS_204.find((g) => g.field === 'price')?.status).toBe('accepted_gap');
    expect(FIELD_GAPS_204.find((g) => g.field === 'variants')?.status).toBe('conditional');
    for (const f of ['title', 'brand', 'description', 'images']) {
      expect(FIELD_GAPS_204.find((g) => g.field === f)?.status).toBe('carried');
    }
  });
});

describe('issue #204 activation evidence (acceptance: three-confirmation-or-waiver basis, preview queued)', () => {
  it('satisfies the count basis on three confirmations with no waiver — evidence only, not the live gate', () => {
    const activation = evaluateActivation204();
    expect(activation.evidenceSatisfied).toBe(true);
    expect(activation.basis).toBe('three_confirmations');
    expect(activation.waiver).toBe(false);
    expect(activation.confirmations).toHaveLength(3);
  });

  it('names the operator-only steps plainly (approval, preview attestation, activation)', () => {
    const { pendingOperatorSteps } = evaluateActivation204();
    expect(pendingOperatorSteps.length).toBeGreaterThanOrEqual(3);
    const joined = pendingOperatorSteps.join(' ');
    expect(joined).toMatch(/per field|per-field/i);
    expect(joined).toMatch(/preview/i);
    expect(joined).toMatch(/activat/i);
  });

  it('names the release-health final authority: the predicate is necessary, not sufficient', () => {
    expect(BONIDE_204_RELEASE_HEALTH_AUTHORITY).toMatch(/getDomainReleaseHealth/);
    expect(
      selectiveReleaseEligibility204({ stageStatus: 'failed_extraction', sameWorkspace: true, urlKind: 'confirmed_clean' }).reason,
    ).toMatch(/getDomainReleaseHealth/);
  });
});

describe('issue #204 selective release (acceptance: eligible items only, no blind draft, no auto-run)', () => {
  it('admits failed-extraction own-workspace items on clean URLs', () => {
    expect(
      selectiveReleaseEligibility204({ stageStatus: 'failed_extraction', sameWorkspace: true, urlKind: 'confirmed_clean' }),
    ).toEqual({ eligible: true, reason: expect.stringMatching(/eligible/) });
  });

  it('rejects ineligible items with clear reasons (#198 hardening)', () => {
    expect(
      selectiveReleaseEligibility204({ stageStatus: 'ready_for_review', sameWorkspace: true, urlKind: 'confirmed_clean' }).eligible,
    ).toBe(false);
    expect(
      selectiveReleaseEligibility204({ stageStatus: 'failed_extraction', sameWorkspace: false, urlKind: 'confirmed_clean' }),
    ).toEqual({ eligible: false, reason: expect.stringMatching(/foreign_workspace/) });
  });

  it('holds variant-blocked, discontinued, and unvalidated URLs out of release', () => {
    expect(
      selectiveReleaseEligibility204({ stageStatus: 'failed_extraction', sameWorkspace: true, urlKind: 'variant_blocked' }),
    ).toEqual({ eligible: false, reason: expect.stringMatching(/variant_resolution_required/) });
    expect(
      selectiveReleaseEligibility204({ stageStatus: 'failed_extraction', sameWorkspace: true, urlKind: 'discontinued_excluded' }),
    ).toEqual({ eligible: false, reason: expect.stringMatching(/wrong_product/) });
    expect(
      selectiveReleaseEligibility204({ stageStatus: 'failed_extraction', sameWorkspace: true, urlKind: 'unknown' }).eligible,
    ).toBe(false);
  });
});
