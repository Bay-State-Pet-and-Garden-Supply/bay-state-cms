// Issue #207 — Shopify minimal profiles tests.
//
// Asserts externally visible behavior at the pre-agreed seams (parent spec
// #197: gates, release eligibility, extraction evidence — never internals):
// six minimal explicit profiles agree with the #201 input verdicts and the
// #202 canonical-host rule, worker validation passes on real product URLs
// for title/description/reviewed-images plus variant correctness (never
// title-only), the per-domain three-confirmation count basis holds without
// waiver, and selective release admits only eligible items. No network, no
// DB — all evidence transcribed.
import { describe, it, expect } from 'vitest';
import {
  SHOPIFY_207_IMAGES_SELECTORS,
  SHOPIFY_207_PROFILES,
  SHOPIFY_207_PROFILE_VERSION,
  SHOPIFY_207_RELEASE_HEALTH_AUTHORITY,
  SHOPIFY_207_RUNTIME,
  SHOPIFY_207_SAMPLES,
  SHOPIFY_207_SHARED_SELECTORS,
  SHOPIFY_207_SHOPIFY_JSON_PATH,
  SHOPIFY_207_TOTAL_ITEMS,
  FIELD_GAPS_207,
  VARIANT_LIMIT_207,
  confirmations207ByDomain,
  evaluateActivation207,
  profile207ByDomain,
  profiles207ReferenceNoEndpoints,
  sample207ByUrl,
  selectiveReleaseEligibility207,
} from '../../onboarding/brand-hub/shopify-minimal-profiles-207';
import { verdict201ByDomain } from '../../onboarding/brand-hub/product-page-verdicts-201';
import { normalizeAlignmentHost } from '../../onboarding/brand-hub/canonical-host-alignment-202';
import { isSupportedSelectorSyntax } from '../../shared/selector-utils';

describe('issue #207 profiles v1 (acceptance: minimal explicit profiles, platform JSON backed, selectors as fallback)', () => {
  it('covers six Shopify domains totaling 53 items (35 as written + 18 scope expansion)', () => {
    expect(SHOPIFY_207_PROFILES).toHaveLength(6);
    expect(SHOPIFY_207_TOTAL_ITEMS).toBe(53);
    expect(SHOPIFY_207_PROFILES.reduce((n, p) => n + p.items, 0)).toBe(53);
    expect(SHOPIFY_207_PROFILE_VERSION).toBe(1);
    expect(SHOPIFY_207_RUNTIME).toBe('static');
  });

  it('records the platform flag as a generation-seeding hint, not a runtime contract', () => {
    expect(SHOPIFY_207_SHOPIFY_JSON_PATH).toBe(true);
  });

  it('every non-null selector uses worker-supported syntax', () => {
    const selectors = [
      SHOPIFY_207_SHARED_SELECTORS.titleSelector,
      SHOPIFY_207_SHARED_SELECTORS.brandSelector,
      SHOPIFY_207_SHARED_SELECTORS.descriptionSelector,
      ...Object.values(SHOPIFY_207_IMAGES_SELECTORS),
    ];
    expect(selectors).toHaveLength(3 + 6);
    for (const sel of selectors) expect(isSupportedSelectorSyntax(sel)).toBe(true);
  });

  it('references no endpoints: fields come from fetched HTML only (platform JSON is authoring-time cross-evidence)', () => {
    expect(profiles207ReferenceNoEndpoints()).toBe(true);
    expect(SHOPIFY_207_SHARED_SELECTORS.titleSelector).toBe('h1');
    expect(SHOPIFY_207_SHARED_SELECTORS.brandSelector.startsWith('meta[')).toBe(true);
    expect(SHOPIFY_207_SHARED_SELECTORS.descriptionSelector.startsWith('meta[')).toBe(true);
    expect(SHOPIFY_207_SHARED_SELECTORS.priceSelector).toBeNull();
  });

  it('agrees with the #201 input verdicts (platform_evidence on all six)', () => {
    for (const profile of SHOPIFY_207_PROFILES) {
      const verdict = verdict201ByDomain(profile.domain.replace(/^www\./, '') === 'wondercide.com' ? 'wondercide.com' : profile.domain);
      expect(verdict?.verdict).toBe('platform_evidence');
    }
  });

  it('agrees with the #202 canonical-host rule (profile keys are fetch hosts)', () => {
    expect(profile207ByDomain('discovernutrisource.com')?.domain).toBe('discovernutrisource.com');
    expect(normalizeAlignmentHost('discovernutrisource.com')).toBe('discovernutrisource.com');
    // www normalization converges both Wondercide forms (release/profile matching strips www.).
    expect(normalizeAlignmentHost('www.wondercide.com')).toBe(normalizeAlignmentHost('wondercide.com'));
    // Every allowlist covers its profile key.
    for (const profile of SHOPIFY_207_PROFILES) {
      const keys = profile.allowedSourceDomains.map(normalizeAlignmentHost);
      expect(keys).toContain(normalizeAlignmentHost(profile.domain));
    }
  });
});

describe('issue #207 worker validation (acceptance: real URLs, all required fields, variant correctness)', () => {
  it('records 26 validation samples across the two verdict kinds', () => {
    expect(SHOPIFY_207_SAMPLES).toHaveLength(26);
    const kinds = new Set(SHOPIFY_207_SAMPLES.map((s) => s.verdict));
    expect(kinds).toEqual(new Set(['confirmed_clean', 'variant_blocked']));
    for (const s of SHOPIFY_207_SAMPLES) {
      expect(s.rationale.length).toBeGreaterThan(80);
      expect(s.jsEvidence.variants).toBeGreaterThanOrEqual(1);
    }
  });

  it('three clean confirmations per domain (18 total), each with title, brand, description, and images', () => {
    for (const profile of SHOPIFY_207_PROFILES) {
      const clean = confirmations207ByDomain(profile.domain);
      expect(clean.map((s) => s.url).sort()).toHaveLength(3);
      for (const s of clean) {
        expect(s.ok).toBe(true);
        expect(s.failureCode).toBeNull();
        expect(s.title).toBeTruthy();
        expect(s.brand).toBeTruthy();
        expect(s.descriptionLength).toBeGreaterThanOrEqual(100);
        expect(s.primaryImages).toBe(1);
        expect(s.provenance.title).toBe('profile-selector');
        expect(s.provenance.brand).toBe('meta');
        expect(s.provenance.description).toBe('meta');
        expect(s.provenance.primaryImage).toBe('profile-selector');
        expect(s.contentHash).toMatch(/^[0-9a-f]{64}$/);
      }
      // Distinct pages, not one page counted thrice.
      expect(new Set(clean.map((s) => s.contentHash)).size).toBe(3);
    }
  });

  it('never relies on title-only presence: every confirmation carries description and image coverage', () => {
    const clean = SHOPIFY_207_SAMPLES.filter((s) => s.verdict === 'confirmed_clean');
    expect(clean).toHaveLength(18);
    for (const s of clean) {
      expect(s.descriptionLength).toBeGreaterThan(0);
      expect(s.primaryImages + s.additionalImages).toBeGreaterThanOrEqual(1);
      expect(s.jsEvidence.title.length).toBeGreaterThan(0);
      expect(s.jsEvidence.vendor.length).toBeGreaterThan(0);
    }
  });

  it('variant-blocked pages fail closed with enumerated candidate matrices (8 URLs)', () => {
    const blocked = SHOPIFY_207_SAMPLES.filter((s) => s.verdict === 'variant_blocked');
    expect(blocked).toHaveLength(8);
    const counts: Record<string, number> = {};
    for (const s of blocked) {
      expect(s.ok).toBe(false);
      expect(s.failureCode).toBe('variant_selection_required');
      expect(s.title).toBeNull();
      expect(s.variantCandidates!.length).toBeGreaterThan(1);
      counts[s.url] = s.variantCandidates!.length;
      for (const c of s.variantCandidates!) {
        expect(c.key.startsWith('shopify:')).toBe(true);
        expect(c.sku.length).toBeGreaterThan(0);
      }
    }
    expect(counts['https://jollypets.com/products/jolly-soccer-ball-dog-toy']).toBe(18);
    expect(counts['https://horsemenspride.com/products/jolly-ball-horse-toy']).toBe(10);
    expect(sample207ByUrl('https://openfarmpet.com/products/dry-dog-food-with-beef')?.variantCandidates).toEqual([
      { key: 'shopify:40059306836081:grass-fed-beef-grain-free-dog-kibble---4-lb', sku: '12870' },
      { key: 'shopify:40059306901617:grass-fed-beef-grain-free-dog-kibble---11-lb', sku: '12871' },
      { key: 'shopify:40059306934385:grass-fed-beef-grain-free-dog-kibble---22-lb', sku: '12872' },
    ]);
  });

  it('records the platform-matrix identifier limit: barcode retries do not resolve (operator selection owns multi-variant release)', () => {
    expect(VARIANT_LIMIT_207).toMatch(/platform_id/);
    expect(VARIANT_LIMIT_207).toMatch(/operator variant-selection/);
    // The Nutrisource and Open Farm blocked rows document barcode-carrying
    // retries that still failed closed (rationales say so explicitly).
    const nutrisource = sample207ByUrl('https://discovernutrisource.com/products/adult-chicken-and-rice-dog-food')!;
    expect(nutrisource.rationale).toMatch(/barcode/i);
    expect(nutrisource.jsEvidence.barcodes.filter(Boolean)).toHaveLength(3);
    expect(nutrisource.variantCandidates).toHaveLength(3);
  });

  it('every required field has a gap entry and no field needs any AI draft', () => {
    expect(FIELD_GAPS_207.map((g) => g.field).sort()).toEqual(
      ['brand', 'description', 'images', 'price', 'title', 'variants'].sort(),
    );
    for (const g of FIELD_GAPS_207) {
      expect(g.draftNeeded).toBe(false);
      expect(g.evidence.length).toBeGreaterThan(80);
    }
    expect(FIELD_GAPS_207.find((g) => g.field === 'price')?.status).toBe('accepted_gap');
    expect(FIELD_GAPS_207.find((g) => g.field === 'variants')?.status).toBe('conditional');
    for (const f of ['title', 'brand', 'description', 'images']) {
      expect(FIELD_GAPS_207.find((g) => g.field === f)?.status).toBe('carried');
    }
  });
});

describe('issue #207 activation evidence (acceptance: three-confirmation-or-waiver basis per domain, preview queued)', () => {
  it('satisfies the count basis on three confirmations per domain with no waivers — evidence only, not the live gate', () => {
    const activations = evaluateActivation207();
    expect(activations).toHaveLength(6);
    for (const activation of activations) {
      expect(activation.evidenceSatisfied).toBe(true);
      expect(activation.basis).toBe('three_confirmations');
      expect(activation.waiver).toBe(false);
      expect(activation.confirmations).toHaveLength(3);
    }
  });

  it('names the operator-only steps plainly per domain (approval, preview attestation, activation)', () => {
    for (const activation of evaluateActivation207()) {
      expect(activation.pendingOperatorSteps.length).toBeGreaterThanOrEqual(3);
      const joined = activation.pendingOperatorSteps.join(' ');
      expect(joined).toMatch(/per field|per-field/i);
      expect(joined).toMatch(/preview/i);
      expect(joined).toMatch(/activat/i);
    }
  });

  it('names the release-health final authority: the predicate is necessary, not sufficient', () => {
    expect(SHOPIFY_207_RELEASE_HEALTH_AUTHORITY).toMatch(/getDomainReleaseHealth/);
    expect(
      selectiveReleaseEligibility207({ stageStatus: 'failed_extraction', sameWorkspace: true, urlKind: 'confirmed_clean' }).reason,
    ).toMatch(/getDomainReleaseHealth/);
  });
});

describe('issue #207 selective release (acceptance: eligible items only, no auto-run)', () => {
  it('admits failed-extraction own-workspace items on clean URLs', () => {
    expect(
      selectiveReleaseEligibility207({ stageStatus: 'failed_extraction', sameWorkspace: true, urlKind: 'confirmed_clean' }),
    ).toEqual({ eligible: true, reason: expect.stringMatching(/eligible/) });
  });

  it('rejects ineligible items with clear reasons (#198 hardening)', () => {
    expect(
      selectiveReleaseEligibility207({ stageStatus: 'ready_for_review', sameWorkspace: true, urlKind: 'confirmed_clean' }).eligible,
    ).toBe(false);
    expect(
      selectiveReleaseEligibility207({ stageStatus: 'failed_extraction', sameWorkspace: false, urlKind: 'confirmed_clean' }),
    ).toEqual({ eligible: false, reason: expect.stringMatching(/foreign_workspace/) });
  });

  it('holds variant-blocked and unvalidated URLs out of release', () => {
    expect(
      selectiveReleaseEligibility207({ stageStatus: 'failed_extraction', sameWorkspace: true, urlKind: 'variant_blocked' }),
    ).toEqual({ eligible: false, reason: expect.stringMatching(/variant_resolution_required/) });
    expect(
      selectiveReleaseEligibility207({ stageStatus: 'failed_extraction', sameWorkspace: true, urlKind: 'unknown' }).eligible,
    ).toBe(false);
  });
});
