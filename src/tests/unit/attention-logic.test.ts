// @vitest-environment node
/**
 * Epic #46 Phase 4 — attention-logic unit tests: grouping, labels,
 * consequence text, domain normalization, profile readiness, candidate
 * presentation. All deterministic — no DOM, no network.
 */
import { describe, it, expect } from 'vitest';
import type { OnboardingWorkState, WorkStateCategory } from '../../shared/schemas/onboarding-work-state';
import type { DomainDiagnosticsEntry } from '../../shared/schemas/onboarding';
import {
  ATTENTION_GROUP_ORDER,
  getAttentionGroupLabel,
  getAttentionGroupChip,
  getAttentionActionLabel,
  getAttentionConsequence,
  domainFromUrl,
  normalizeDomain,
  deriveProfileReadiness,
  PROFILE_READINESS_LABELS,
  groupAttentionItems,
  candidateMethodLabel,
  formatConfidence,
  candidateWhy,
} from '../../client/components/onboarding/attention/attention-logic';

function makeWorkState(
  id: string,
  attentionReason: OnboardingWorkState['attentionReason'],
  category: WorkStateCategory = 'needs_attention',
): OnboardingWorkState {
  return {
    itemId: id,
    category,
    activity: null,
    label: 'Needs decision',
    detail: null,
    attentionReason,
    attentionAction: attentionReason === 'processing_failed' ? 'retry_processing' : 'verify_official_url',
    findingCode: null,
    findingSummary: null,
    conflictingValues: null,
    suggestedAction: null,
    findingDetails: null,
    family: null,
    reviewState: 'not_ready',
    stage: 'discovery',
    stageStatus: 'needs_input',
    upc: `upc-${id}`,
    name: `Product ${id}`,
    brand: null,
    sourceType: null,
    domain: null,
    curatedTitle: null,
    imageUrl: null,
    description: null,
    weight: null,
    variantResolution: null,
  };
}

function makeDiagnostics(domain: string, overrides: Partial<DomainDiagnosticsEntry> = {}): DomainDiagnosticsEntry {
  return {
    domain,
    hasActiveProfile: false,
    activeProfileId: null,
    profileUpdatedAt: null,
    sitemapUrlsCount: 0,
    sitemapFetchedAt: null,
    sitemapExpiresAt: null,
    sitemapSourceUrl: null,
    sitemapStale: false,
    healthStatus: 'unknown',
    healthCheckedAt: null,
    healthReason: null,
    healthStale: false,
    brandAssociations: [],
    generationCount: 0,
    latestGenerationStatus: null,
    latestGenerationAt: null,
    ...overrides,
  };
}

describe('groupAttentionItems', () => {
  it('groups by reason in canonical order and puts unknown last', () => {
    const groups = groupAttentionItems([
      makeWorkState('a', 'processing_failed'),
      makeWorkState('b', 'verify_official_url'),
      makeWorkState('c', 'source_conflict'),
      makeWorkState('d', null),
      makeWorkState('e', 'verify_official_url'),
    ]);
    expect(groups.map((g) => g.reason)).toEqual([
      'verify_official_url',
      'source_conflict',
      'processing_failed',
      'unknown',
    ]);
    expect(groups[0].items.map((i) => i.itemId)).toEqual(['b', 'e']);
    expect(groups.find((g) => g.reason === 'unknown')?.items.map((i) => i.itemId)).toEqual(['d']);
  });

  it('returns an empty array for no items', () => {
    expect(groupAttentionItems([])).toEqual([]);
  });

  it('covers every canonical reason exactly once in order', () => {
    const reasons = ATTENTION_GROUP_ORDER.map((g) => g.reason);
    // Ticket #104 justification (no production change): ticket #103 added
    // the `manual_evidence_available` canonical reason to
    // ATTENTION_GROUP_ORDER without updating this exhaustive list. This
    // records the current order including that reason.
    expect(reasons).toEqual([
      'brand_not_provided',
      'verify_official_url',
      'no_official_url',
      'choose_official_url',
      'choose_variant',
      'extractor_profile_required',
      'manual_evidence_available',
      'extraction_profile_failed',
      'source_conflict',
      'processing_failed',
      'semantic_validation_blocked',
      'unknown',
    ]);
  });
});

describe('labels', () => {
  it('maps every reason to a human group label', () => {
    expect(getAttentionGroupLabel('brand_not_provided')).toBe('Brand assignment required');
    expect(getAttentionGroupLabel('verify_official_url')).toBe('Verify official product page');
    expect(getAttentionGroupLabel('no_official_url')).toBe('Official product page not found');
    expect(getAttentionGroupLabel('choose_official_url')).toBe('Choose the correct product page');
    expect(getAttentionGroupLabel('choose_variant')).toBe('Choose product variant');
    expect(getAttentionGroupLabel('extractor_profile_required')).toBe('Extractor setup required');
    expect(getAttentionGroupLabel('extraction_profile_failed')).toBe('Extraction / profile failure');
    expect(getAttentionGroupLabel('source_conflict')).toBe('Distributor match conflict');
    expect(getAttentionGroupLabel('processing_failed')).toBe('Processing failure');
    expect(getAttentionGroupLabel(null)).toBe('Other');
    expect(getAttentionGroupLabel(undefined)).toBe('Other');
  });

  it('maps every action to a plain-language action label', () => {
    expect(getAttentionActionLabel('assign_brand')).toBe('Assign brand');
    expect(getAttentionActionLabel('verify_official_url')).toBe('Confirm the page');
    expect(getAttentionActionLabel('choose_official_url')).toBe('Choose a page');
    expect(getAttentionActionLabel('choose_variant')).toBe('Choose product variant');
    expect(getAttentionActionLabel('setup_extractor_profile')).toBe('Set up extraction');
    expect(getAttentionActionLabel('retry_extraction')).toBe('Retry extraction');
    expect(getAttentionActionLabel('resolve_source_conflict')).toBe('Resolve conflict');
    expect(getAttentionActionLabel('retry_processing')).toBe('Retry');
    expect(getAttentionActionLabel('resolve_semantic_conflict')).toBe('Review curation findings');
    expect(getAttentionActionLabel(null)).toBe('Resolve');
  });

  it('exposes short chip labels for the filter row', () => {
    expect(getAttentionGroupChip('brand_not_provided')).toBe('Needs brand');
    expect(getAttentionGroupChip('source_conflict')).toBe('Conflict');
    expect(getAttentionGroupChip(null)).toBe('Other');
  });
});

describe('getAttentionConsequence', () => {
  it('answers "what happens next" deterministically per reason', () => {
    expect(getAttentionConsequence('brand_not_provided')).toContain('Assign the brand to run distributor lookup');
    expect(getAttentionConsequence('verify_official_url')).toContain('extraction resumes automatically');
    expect(getAttentionConsequence('no_official_url')).toContain('official product page URL');
    expect(getAttentionConsequence('choose_official_url')).toContain('extraction resumes automatically');
    expect(getAttentionConsequence('choose_variant')).toContain('extraction resumes automatically');
    expect(getAttentionConsequence('extractor_profile_required')).toContain('blocked products resume automatically');
    expect(getAttentionConsequence('extraction_profile_failed')).toContain('released together');
    expect(getAttentionConsequence('source_conflict')).toContain('sourcing continues automatically');
    expect(getAttentionConsequence('processing_failed')).toBe('Retry processing for this product.');
    expect(getAttentionConsequence('semantic_validation_blocked')).toContain('re-run Curation');
    expect(getAttentionConsequence('semantic_validation_blocked')).toContain('returns to Review');
    expect(getAttentionConsequence(null, 'some detail')).toBe(
      'Resolve the blocker and processing continues automatically.',
    );
  });
});

describe('domain helpers', () => {
  it('normalizes hosts and strips www', () => {
    expect(domainFromUrl('https://www.BlueBuffalo.com/p/123')).toBe('bluebuffalo.com');
    expect(domainFromUrl('http://bluebuffalo.com/p/123')).toBe('bluebuffalo.com');
    expect(domainFromUrl(null)).toBeNull();
    expect(domainFromUrl('not a url')).toBeNull();
  });

  it('normalizes domain strings', () => {
    expect(normalizeDomain('WWW.BlueBuffalo.com')).toBe('bluebuffalo.com');
    expect(normalizeDomain('  bluebuffalo.com ')).toBe('bluebuffalo.com');
  });
});

describe('deriveProfileReadiness', () => {
  const entries = [
    makeDiagnostics('bluebuffalo.com', { hasActiveProfile: true, activeProfileId: 'p1' }),
    makeDiagnostics('nutro.com', { latestGenerationStatus: 'failed' }),
    makeDiagnostics('royalcanin.com'),
  ];

  it('returns ready when an active profile exists', () => {
    const r = deriveProfileReadiness('www.bluebuffalo.com', entries);
    expect(r.state).toBe('ready');
    expect(r.entry?.activeProfileId).toBe('p1');
  });

  it('returns failed when generation failed and no active profile', () => {
    expect(deriveProfileReadiness('nutro.com', entries).state).toBe('failed');
  });

  it('returns missing when no profile has been attempted', () => {
    expect(deriveProfileReadiness('royalcanin.com', entries).state).toBe('missing');
  });

  it('returns unknown when the domain has no diagnostics entry', () => {
    expect(deriveProfileReadiness('unknownbrand.com', entries).state).toBe('unknown');
  });

  it('returns unknown for a null domain', () => {
    expect(deriveProfileReadiness(null, entries).state).toBe('unknown');
  });

  it('matches every readiness label', () => {
    expect(PROFILE_READINESS_LABELS.ready).toBe('Extractor ready');
    expect(PROFILE_READINESS_LABELS.missing).toBe('No working extractor for this domain');
    expect(PROFILE_READINESS_LABELS.failed).toBe('Extractor generation failed');
    expect(PROFILE_READINESS_LABELS.unknown).toBe('Extractor status unknown');
  });
});

describe('candidate presentation', () => {
  it('formats confidence', () => {
    expect(formatConfidence(0.86)).toBe('86%');
    expect(formatConfidence(1)).toBe('100%');
    expect(formatConfidence(null)).toBe('—');
    expect(formatConfidence(undefined)).toBe('—');
    expect(formatConfidence(Number.NaN)).toBe('—');
  });

  it('labels source methods', () => {
    expect(candidateMethodLabel('shopify_variant')).toBe('Variant match');
    // SERP retirement: legacy serper_* methods collapse to one honest label.
    expect(candidateMethodLabel('serper_name')).toBe('Legacy web search');
    expect(candidateMethodLabel('serper_upc')).toBe('Legacy web search');
    expect(candidateMethodLabel('sitemap')).toBe('Sitemap match');
    expect(candidateMethodLabel('manual')).toBe('Manually added');
    expect(candidateMethodLabel(null)).toBe('Search result');
  });

  it('builds a short honest why-line', () => {
    const why = candidateWhy({
      id: 's1',
      itemId: 'i1',
      url: 'https://bluebuffalo.com/p/1',
      title: 'Blue Buffalo Life Protection',
      snippet: null,
      domain: 'bluebuffalo.com',
      confidence: 0.9,
      isSelected: false,
      sourceMethod: 'serper_upc',
      reviewStatus: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(why).toContain('Found via Legacy web search');
    expect(why).toContain('90% confidence');

    const withRecommendation = candidateWhy({
      id: 's2',
      itemId: 'i1',
      url: 'https://bluebuffalo.com/p/2',
      title: null,
      snippet: null,
      domain: 'bluebuffalo.com',
      confidence: 0.5,
      isSelected: false,
      sourceMethod: 'sitemap',
      recommendation: 'Matches size variant 30 lb',
      reviewStatus: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(withRecommendation).toContain('Matches size variant 30 lb');
    expect(withRecommendation).toContain('50% confidence');
  });
});
