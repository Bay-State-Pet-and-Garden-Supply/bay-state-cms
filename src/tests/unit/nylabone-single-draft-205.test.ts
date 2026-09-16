// Issue #205 — Nylabone single Sitecore draft tests.
//
// Asserts externally visible behavior at the pre-agreed seams (parent spec
// #197: gates, release eligibility, extraction evidence — never internals):
// the draft v1 selector set is worker-supported syntax with no assumed
// endpoint fetching and no unresolvable jsonld: selectors, worker
// validation passes on real Nylabone product URLs spanning 2+ templates,
// per-field approve/reject is preserved (partial generations usable), the
// three-confirmation count basis holds without waiver, and selective
// release admits only eligible items. No network, no DB — all evidence
// transcribed.
import { describe, it, expect } from 'vitest';
import {
  NYLABONE_205_DOMAIN,
  NYLABONE_205_TOTAL_ITEMS,
  NYLABONE_205_PROFILE_VERSION,
  NYLABONE_205_RELEASE_HEALTH_AUTHORITY,
  NYLABONE_205_RUNTIME,
  NYLABONE_205_SAMPLES,
  NYLABONE_205_SELECTORS,
  NYLABONE_205_TEMPLATES,
  FIELD_DECISIONS_205,
  SITECORE_JSONLD_CORRECTION_205,
  TEMPLATE_FINDING_205,
  VARIANT_CAVEAT_205,
  draft205ReferencesNoEndpoints,
  draft205UsesNoUnresolvableJsonLd,
  evaluateActivation205,
  sample205ByUrl,
  selectiveReleaseEligibility205,
} from '../../onboarding/brand-hub/nylabone-single-draft-205';
import { verdict201ByDomain } from '../../onboarding/brand-hub/product-page-verdicts-201';
import { isSupportedSelectorSyntax } from '../../shared/selector-utils';

describe('issue #205 draft v1 (acceptance: explicit selectors, per-field approve/reject, partial usable)', () => {
  it('targets www.nylabone.com with a static runtime and the five-item scope', () => {
    expect(NYLABONE_205_DOMAIN).toBe('www.nylabone.com');
    expect(NYLABONE_205_RUNTIME).toBe('static');
    expect(NYLABONE_205_TOTAL_ITEMS).toBe(5);
    expect(NYLABONE_205_PROFILE_VERSION).toBe(1);
  });

  it('every non-null selector uses worker-supported syntax', () => {
    const selectors = [
      NYLABONE_205_SELECTORS.titleSelector,
      NYLABONE_205_SELECTORS.descriptionSelector,
      NYLABONE_205_SELECTORS.imagesSelector,
    ];
    expect(selectors).toHaveLength(3);
    for (const sel of selectors) expect(isSupportedSelectorSyntax(sel)).toBe(true);
  });

  it('references no endpoints: fields come from fetched HTML only', () => {
    expect(draft205ReferencesNoEndpoints()).toBe(true);
    expect(NYLABONE_205_SELECTORS.titleSelector).toBe('h1');
    expect(NYLABONE_205_SELECTORS.descriptionSelector.startsWith('meta[')).toBe(true);
    expect(NYLABONE_205_SELECTORS.imagesSelector).toContain('product-image-gallery');
    expect(NYLABONE_205_SELECTORS.brandSelector).toBeNull();
    expect(NYLABONE_205_SELECTORS.priceSelector).toBeNull();
  });

  it('uses no unresolvable jsonld: selectors (Sitecore capitalized-key correction reflected)', () => {
    expect(draft205UsesNoUnresolvableJsonLd()).toBe(true);
    expect(SITECORE_JSONLD_CORRECTION_205).toMatch(/capitalized/i);
    expect(SITECORE_JSONLD_CORRECTION_205).toMatch(/Gtin12/);
  });

  it('agrees with the #201 input verdict (nylabone.com ai_draft)', () => {
    expect(verdict201ByDomain('nylabone.com')?.verdict).toBe('ai_draft');
  });

  it('preserves per-field approve/reject: partial generation still usable', () => {
    expect(FIELD_DECISIONS_205.map((g) => g.field).sort()).toEqual(
      ['brand', 'description', 'images', 'price', 'title', 'variants'].sort(),
    );
    // Approved fields carry selectors; rejected fields name a non-draft owner.
    for (const f of ['title', 'description', 'images']) {
      const row = FIELD_DECISIONS_205.find((g) => g.field === f)!;
      expect(row.decision).toBe('approve');
      expect(row.selector).toBeTruthy();
    }
    for (const f of ['brand', 'price']) {
      const row = FIELD_DECISIONS_205.find((g) => g.field === f)!;
      expect(row.decision).toBe('reject');
      expect(row.selector).toBeNull();
      expect(row.carriedBy).not.toMatch(/draft v1 \(this record\)$/);
    }
    expect(FIELD_DECISIONS_205.find((g) => g.field === 'variants')?.decision).toBe('conditional');
    for (const g of FIELD_DECISIONS_205) expect(g.evidence.length).toBeGreaterThan(80);
  });
});

describe('issue #205 worker validation (acceptance: 2+ templates passing, shared structure proven)', () => {
  it('records six validation samples, all confirmed clean', () => {
    expect(NYLABONE_205_SAMPLES).toHaveLength(6);
    for (const s of NYLABONE_205_SAMPLES) {
      expect(s.verdict).toBe('confirmed_clean');
      expect(s.ok).toBe(true);
      expect(s.failureCode).toBeNull();
      expect(s.url.startsWith('https://www.nylabone.com/products/product-type/')).toBe(true);
      expect(s.rationale.length).toBeGreaterThan(80);
    }
  });

  it('spans 2+ distinct product templates with passing results on each', () => {
    const templates = new Set(NYLABONE_205_SAMPLES.map((s) => s.template));
    expect(templates.size).toBeGreaterThanOrEqual(2);
    expect(templates.has('power-chew')).toBe(true);
    expect(templates.has('edible-chew-treats')).toBe(true);
    expect(templates.has('dental-solutions')).toBe(true);
    // Every spanned template has a passing result.
    for (const t of templates) {
      expect(NYLABONE_205_SAMPLES.some((s) => s.template === t && s.ok)).toBe(true);
    }
    expect(NYLABONE_205_TEMPLATES.map((t) => t.label)).toEqual(
      expect.arrayContaining(['power-chew', 'edible-chew-treats', 'dental-solutions']),
    );
  });

  it('six distinct pages with correct family titles and profile-selector/meta provenance', () => {
    for (const s of NYLABONE_205_SAMPLES) {
      expect(s.title).toBeTruthy();
      expect(s.provenance.title).toBe('profile-selector');
      expect(s.provenance.description).toBe('meta');
      expect(s.provenance.primaryImage).toBe('profile-selector');
      expect(s.contentHash).toBeTruthy();
    }
    expect(new Set(NYLABONE_205_SAMPLES.map((s) => s.contentHash)).size).toBe(6);
    expect(sample205ByUrl('https://www.nylabone.com/products/product-type/chew-toys/power-chew/dura-chew-power-chew-textured-bone')?.title).toBe(
      'Power Chew Groove Bone Dog Chew Toy',
    );
  });

  it('records the single-structure finding explicitly (no silent single-template coverage)', () => {
    expect(TEMPLATE_FINDING_205).toMatch(/single shared/i);
    expect(TEMPLATE_FINDING_205).toMatch(/no multi-structure dispatch needed/i);
  });

  it('records the variant caveat: no worker matrix on Sitecore pages, no silent wrong-SKU confidence', () => {
    for (const s of NYLABONE_205_SAMPLES) expect(s.matrixDecision).toBeNull();
    expect(VARIANT_CAVEAT_205).toMatch(/no variant matrix/i);
    expect(VARIANT_CAVEAT_205).toMatch(/operator variant selection/i);
  });
});

describe('issue #205 activation evidence (acceptance: three-confirmation-or-waiver basis, preview queued)', () => {
  it('satisfies the count basis on six confirmations across 3 templates with no waiver', () => {
    const activation = evaluateActivation205();
    expect(activation.evidenceSatisfied).toBe(true);
    expect(activation.basis).toBe('three_confirmations');
    expect(activation.waiver).toBe(false);
    expect(activation.confirmations).toHaveLength(6);
    expect(activation.templatesSpanned.length).toBeGreaterThanOrEqual(2);
  });

  it('names the operator-only steps plainly (approval, preview attestation, variant posture, activation)', () => {
    const { pendingOperatorSteps } = evaluateActivation205();
    expect(pendingOperatorSteps.length).toBeGreaterThanOrEqual(4);
    const joined = pendingOperatorSteps.join(' ');
    expect(joined).toMatch(/per field|per-field/i);
    expect(joined).toMatch(/preview/i);
    expect(joined).toMatch(/variant/i);
    expect(joined).toMatch(/activat/i);
  });

  it('names the release-health final authority: the predicate is necessary, not sufficient', () => {
    expect(NYLABONE_205_RELEASE_HEALTH_AUTHORITY).toMatch(/getDomainReleaseHealth/);
    expect(
      selectiveReleaseEligibility205({ stageStatus: 'failed_extraction', sameWorkspace: true, urlKind: 'confirmed_clean' }).reason,
    ).toMatch(/getDomainReleaseHealth/);
  });
});

describe('issue #205 selective release (acceptance: eligible items only, no auto-run)', () => {
  it('admits failed-extraction own-workspace items on clean URLs', () => {
    expect(
      selectiveReleaseEligibility205({ stageStatus: 'failed_extraction', sameWorkspace: true, urlKind: 'confirmed_clean' }),
    ).toEqual({ eligible: true, reason: expect.stringMatching(/eligible/) });
  });

  it('rejects ineligible items with clear reasons (#198 hardening)', () => {
    expect(
      selectiveReleaseEligibility205({ stageStatus: 'ready_for_review', sameWorkspace: true, urlKind: 'confirmed_clean' }).eligible,
    ).toBe(false);
    expect(
      selectiveReleaseEligibility205({ stageStatus: 'failed_extraction', sameWorkspace: false, urlKind: 'confirmed_clean' }),
    ).toEqual({ eligible: false, reason: expect.stringMatching(/foreign_workspace/) });
  });

  it('holds size-specific and unvalidated URLs out of release', () => {
    expect(
      selectiveReleaseEligibility205({ stageStatus: 'failed_extraction', sameWorkspace: true, urlKind: 'size_specific_pending_selection' }),
    ).toEqual({ eligible: false, reason: expect.stringMatching(/variant_resolution_required/) });
    expect(
      selectiveReleaseEligibility205({ stageStatus: 'failed_extraction', sameWorkspace: true, urlKind: 'unknown' }).eligible,
    ).toBe(false);
  });
});
