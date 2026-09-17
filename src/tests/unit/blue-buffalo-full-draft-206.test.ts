// Issue #206 — Blue Buffalo full AI draft tests.
//
// Asserts externally visible behavior at the pre-agreed seams (parent spec
// #197: gates, release eligibility, extraction evidence — never internals):
// the draft v1 selector set is worker-supported syntax with no assumed
// endpoint fetching and no unresolvable jsonld: selectors, worker
// validation passes on real Blue Buffalo product URLs spanning 2+
// templates with recipe-distinct titles (the h1 fallback is proven),
// per-field approve/reject is preserved (partial generations usable), the
// three-confirmation count basis holds without waiver, LLM cost is
// recorded, and selective release admits only eligible items. No network,
// no DB — all evidence transcribed.
import { describe, it, expect } from 'vitest';
import {
  BLUEBUFFALO_206_DOMAIN,
  BLUEBUFFALO_206_TOTAL_ITEMS,
  BLUEBUFFALO_206_PROFILE_VERSION,
  BLUEBUFFALO_206_RELEASE_HEALTH_AUTHORITY,
  BLUEBUFFALO_206_RUNTIME,
  BLUEBUFFALO_206_SAMPLES,
  BLUEBUFFALO_206_SELECTORS,
  BLUEBUFFALO_206_TEMPLATES,
  FIELD_DECISIONS_206,
  H1_GENERIC_FINDING_206,
  LLM_COST_206,
  TEMPLATE_FINDING_206,
  VARIANT_CAVEAT_206,
  draft206ReferencesNoEndpoints,
  draft206UsesNoUnresolvableJsonLd,
  evaluateActivation206,
  sample206ByUrl,
  selectiveReleaseEligibility206,
} from '../../onboarding/brand-hub/blue-buffalo-full-draft-206';
import { verdict201ByDomain } from '../../onboarding/brand-hub/product-page-verdicts-201';
import { isSupportedSelectorSyntax } from '../../shared/selector-utils';

describe('issue #206 draft v1 (acceptance: explicit selectors, per-field approve/reject, partial usable)', () => {
  it('targets www.bluebuffalo.com with a static runtime and the seven-item scope', () => {
    expect(BLUEBUFFALO_206_DOMAIN).toBe('www.bluebuffalo.com');
    expect(BLUEBUFFALO_206_RUNTIME).toBe('static');
    expect(BLUEBUFFALO_206_TOTAL_ITEMS).toBe(7);
    expect(BLUEBUFFALO_206_PROFILE_VERSION).toBe(1);
  });

  it('every non-null selector uses worker-supported syntax', () => {
    const selectors = [
      BLUEBUFFALO_206_SELECTORS.titleSelector,
      BLUEBUFFALO_206_SELECTORS.descriptionSelector,
      BLUEBUFFALO_206_SELECTORS.imagesSelector,
    ];
    expect(selectors).toHaveLength(3);
    for (const sel of selectors) expect(isSupportedSelectorSyntax(sel)).toBe(true);
  });

  it('references no endpoints: fields come from fetched HTML only', () => {
    expect(draft206ReferencesNoEndpoints()).toBe(true);
    expect(BLUEBUFFALO_206_SELECTORS.titleSelector.startsWith('meta[')).toBe(true);
    expect(BLUEBUFFALO_206_SELECTORS.descriptionSelector.startsWith('meta[')).toBe(true);
    expect(BLUEBUFFALO_206_SELECTORS.imagesSelector).toContain('Hero--product');
    expect(BLUEBUFFALO_206_SELECTORS.brandSelector).toBeNull();
    expect(BLUEBUFFALO_206_SELECTORS.priceSelector).toBeNull();
  });

  it('uses no unresolvable jsonld: selectors (zero-ld+json reality reflected)', () => {
    expect(draft206UsesNoUnresolvableJsonLd()).toBe(true);
  });

  it('falls back from the generic h1 to og:title (visual-select fallback per field)', () => {
    expect(BLUEBUFFALO_206_SELECTORS.titleSelector).toBe('meta[property="og:title"]');
    expect(H1_GENERIC_FINDING_206).toMatch(/generic/i);
    expect(H1_GENERIC_FINDING_206).toMatch(/og:title/);
  });

  it('records LLM cost for observability (zero-cost hand draft)', () => {
    expect(LLM_COST_206).toMatch(/zero/i);
    expect(LLM_COST_206.length).toBeGreaterThan(20);
  });

  it('agrees with the #201 input verdict (bluebuffalo.com ai_draft)', () => {
    expect(verdict201ByDomain('bluebuffalo.com')?.verdict).toBe('ai_draft');
  });

  it('preserves per-field approve/reject: partial generation still usable', () => {
    expect(FIELD_DECISIONS_206.map((g) => g.field).sort()).toEqual(
      ['brand', 'description', 'images', 'price', 'title', 'variants'].sort(),
    );
    // Approved fields carry selectors; rejected fields name a non-draft owner.
    for (const f of ['title', 'description', 'images']) {
      const row = FIELD_DECISIONS_206.find((g) => g.field === f)!;
      expect(row.decision).toBe('approve');
      expect(row.selector).toBeTruthy();
    }
    for (const f of ['brand', 'price']) {
      const row = FIELD_DECISIONS_206.find((g) => g.field === f)!;
      expect(row.decision).toBe('reject');
      expect(row.selector).toBeNull();
      expect(row.carriedBy).not.toMatch(/draft v1 \(this record\)$/);
    }
    expect(FIELD_DECISIONS_206.find((g) => g.field === 'variants')?.decision).toBe('conditional');
    for (const g of FIELD_DECISIONS_206) expect(g.evidence.length).toBeGreaterThan(80);
  });
});

describe('issue #206 worker validation (acceptance: 2+ templates passing, shared structure proven)', () => {
  it('records six validation samples, all confirmed clean', () => {
    expect(BLUEBUFFALO_206_SAMPLES).toHaveLength(6);
    for (const s of BLUEBUFFALO_206_SAMPLES) {
      expect(s.verdict).toBe('confirmed_clean');
      expect(s.ok).toBe(true);
      expect(s.failureCode).toBeNull();
      expect(s.url.startsWith('https://www.bluebuffalo.com/')).toBe(true);
      expect(s.rationale.length).toBeGreaterThan(80);
    }
  });

  it('spans 2+ distinct product templates with passing results on each', () => {
    const templates = new Set(BLUEBUFFALO_206_SAMPLES.map((s) => s.template));
    expect(templates.size).toBeGreaterThanOrEqual(2);
    expect(templates.has('lpf-dry')).toBe(true);
    expect(templates.has('wilderness-dry')).toBe(true);
    expect(templates.has('wet-homestyle')).toBe(true);
    expect(templates.has('treats-healthbars')).toBe(true);
    // Every spanned template has a passing result.
    for (const t of templates) {
      expect(BLUEBUFFALO_206_SAMPLES.some((s) => s.template === t && s.ok)).toBe(true);
    }
    expect(BLUEBUFFALO_206_TEMPLATES.map((t) => t.label)).toEqual(
      expect.arrayContaining(['lpf-dry', 'wilderness-dry', 'wet-homestyle', 'treats-healthbars']),
    );
  });

  it('six distinct pages with recipe-distinct titles and meta/profile-selector provenance', () => {
    for (const s of BLUEBUFFALO_206_SAMPLES) {
      expect(s.title).toBeTruthy();
      expect(s.provenance.title).toBe('meta');
      expect(s.provenance.description).toBe('meta');
      expect(s.provenance.primaryImage).toBe('profile-selector');
      expect(s.contentHash).toBeTruthy();
    }
    expect(new Set(BLUEBUFFALO_206_SAMPLES.map((s) => s.contentHash)).size).toBe(6);
    expect(new Set(BLUEBUFFALO_206_SAMPLES.map((s) => s.title)).size).toBe(6);
    expect(sample206ByUrl('https://www.bluebuffalo.com/dry-dog-food/life-protection-formula/chicken-brown-rice-recipe/')?.title).toBe(
      'Life Protection Formula Adult Dry Dog Food - Chicken & Brown Rice',
    );
  });

  it('proves recipe distinction where h1 cannot (LPF chicken vs salmon differ)', () => {
    const chicken = sample206ByUrl('https://www.bluebuffalo.com/dry-dog-food/life-protection-formula/chicken-brown-rice-recipe/');
    const salmon = sample206ByUrl('https://www.bluebuffalo.com/dry-dog-food/life-protection-formula/salmon-brown-rice-recipe/');
    expect(chicken?.title).not.toBe(salmon?.title);
    expect(chicken?.title).toMatch(/Chicken/);
    expect(salmon?.title).toMatch(/Salmon/);
  });

  it('records the single-structure finding explicitly (no silent single-template coverage)', () => {
    expect(TEMPLATE_FINDING_206).toMatch(/single shared/i);
    expect(TEMPLATE_FINDING_206).toMatch(/no multi-structure dispatch needed/i);
  });

  it('records the variant caveat: no worker matrix on DXP pages, no silent wrong-SKU confidence', () => {
    for (const s of BLUEBUFFALO_206_SAMPLES) expect(s.matrixDecision).toBeNull();
    expect(VARIANT_CAVEAT_206).toMatch(/no variant matrix/i);
    expect(VARIANT_CAVEAT_206).toMatch(/operator variant selection/i);
  });
});

describe('issue #206 activation evidence (acceptance: three-confirmation-or-waiver basis, preview queued)', () => {
  it('satisfies the count basis on six confirmations across 4 templates with no waiver', () => {
    const activation = evaluateActivation206();
    expect(activation.evidenceSatisfied).toBe(true);
    expect(activation.basis).toBe('three_confirmations');
    expect(activation.waiver).toBe(false);
    expect(activation.confirmations).toHaveLength(6);
    expect(activation.templatesSpanned.length).toBeGreaterThanOrEqual(2);
  });

  it('names the operator-only steps plainly (approval, preview attestation, variant posture, activation)', () => {
    const { pendingOperatorSteps } = evaluateActivation206();
    expect(pendingOperatorSteps.length).toBeGreaterThanOrEqual(4);
    const joined = pendingOperatorSteps.join(' ');
    expect(joined).toMatch(/per field|per-field/i);
    expect(joined).toMatch(/preview/i);
    expect(joined).toMatch(/variant/i);
    expect(joined).toMatch(/activat/i);
  });

  it('names the release-health final authority: the predicate is necessary, not sufficient', () => {
    expect(BLUEBUFFALO_206_RELEASE_HEALTH_AUTHORITY).toMatch(/getDomainReleaseHealth/);
    expect(
      selectiveReleaseEligibility206({ stageStatus: 'failed_extraction', sameWorkspace: true, urlKind: 'confirmed_clean' }).reason,
    ).toMatch(/getDomainReleaseHealth/);
  });
});

describe('issue #206 selective release (acceptance: eligible items only, no auto-run)', () => {
  it('admits failed-extraction own-workspace items on clean URLs', () => {
    expect(
      selectiveReleaseEligibility206({ stageStatus: 'failed_extraction', sameWorkspace: true, urlKind: 'confirmed_clean' }),
    ).toEqual({ eligible: true, reason: expect.stringMatching(/eligible/) });
  });

  it('rejects ineligible items with clear reasons (#198 hardening)', () => {
    expect(
      selectiveReleaseEligibility206({ stageStatus: 'ready_for_review', sameWorkspace: true, urlKind: 'confirmed_clean' }).eligible,
    ).toBe(false);
    expect(
      selectiveReleaseEligibility206({ stageStatus: 'failed_extraction', sameWorkspace: false, urlKind: 'confirmed_clean' }),
    ).toEqual({ eligible: false, reason: expect.stringMatching(/foreign_workspace/) });
  });

  it('holds size-specific and unvalidated URLs out of release', () => {
    expect(
      selectiveReleaseEligibility206({ stageStatus: 'failed_extraction', sameWorkspace: true, urlKind: 'size_specific_pending_selection' }),
    ).toEqual({ eligible: false, reason: expect.stringMatching(/variant_resolution_required/) });
    expect(
      selectiveReleaseEligibility206({ stageStatus: 'failed_extraction', sameWorkspace: true, urlKind: 'unknown' }).eligible,
    ).toBe(false);
  });
});
