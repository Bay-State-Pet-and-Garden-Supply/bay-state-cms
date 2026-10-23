/**
 * Unit tests for `src/client/components/profile-builder/profileBuilderMapping.ts`.
 *
 * Pure mapping utilities — no DOM, no API, no React. Runs under vitest.
 */

import { describe, it, expect } from 'vitest';
import {
  createEmptyDraft,
  profileToDraft,
  draftToSavePayload,
  draftToValidatePayload,
  draftToTestPayload,
  draftToSelectorMap,
  emptyToNull,
  omitEmptyValues,
} from '@/client/components/profile-builder/profileBuilderMapping';
import type { ExtractorProfile } from '@/client/components/profile-builder/profileBuilderTypes';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeProfile(overrides?: Partial<ExtractorProfile>): ExtractorProfile {
  return {
    id: 'prof-1',
    domain: 'acmepet.com',
    titleSelector: 'h1.product-title',
    titleOptionalSelectors: ['.subtitle'],
    priceSelector: '.price-amount',
    descriptionSelector: '.desc-long',
    brandSelector: '.brand-name',
    imagesSelector: '.gallery img',
    customSelectors: { weightSelector: '.weight', flavorSelector: '.flavor' },
    sitemapProductUrlPattern: '/products/',
    shopifyJSONPath: false,
    variantSelectionStrategy: null,
    customSelectorMetadata: { weightSelector: { unit: 'oz' } },
    runtime: 'rendered',
    profileType: 'brand',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

// ─── createEmptyDraft ────────────────────────────────────────────────────────

describe('createEmptyDraft', () => {
  it('creates a default empty draft', () => {
    const draft = createEmptyDraft();
    expect(draft.domain).toBe('');
    expect(draft.runtime).toBe('rendered');
    expect(draft.productUrl).toBe('');
    expect(draft.titleSelector).toBeNull();
    expect(draft.titleOptionalSelectors).toEqual([]);
    expect(draft.brandSelector).toBeNull();
    expect(draft.descriptionSelector).toBeNull();
    expect(draft.imagesSelector).toBeNull();
    expect(draft.priceSelector).toBeNull();
    expect(draft.customSelectors).toEqual({});
    expect(draft.sitemapProductUrlPattern).toBeNull();
    expect(draft.shopifyJSONPath).toBe(false);
    expect(draft.variantSelectionStrategy).toBeNull();
    expect(draft.customSelectorMetadata).toEqual({});
  });

  it('sets domain when provided', () => {
    const draft = createEmptyDraft({ domain: 'example.com' });
    expect(draft.domain).toBe('example.com');
  });

  it('sets productUrl when provided', () => {
    const draft = createEmptyDraft({ productUrl: 'https://example.com/p/1' });
    expect(draft.productUrl).toBe('https://example.com/p/1');
  });

  it('sets runtime when provided', () => {
    const draft = createEmptyDraft({ runtime: 'static' });
    expect(draft.runtime).toBe('static');
  });
});

// ─── profileToDraft ──────────────────────────────────────────────────────────

describe('profileToDraft', () => {
  it('maps core fields from an ExtractorProfile', () => {
    const profile = makeProfile();
    const draft = profileToDraft(profile);

    expect(draft.domain).toBe('acmepet.com');
    expect(draft.runtime).toBe('rendered');
    expect(draft.titleSelector).toBe('h1.product-title');
    expect(draft.titleOptionalSelectors).toEqual(['.subtitle']);
    expect(draft.priceSelector).toBeNull();
    expect(draft.descriptionSelector).toBe('.desc-long');
    expect(draft.brandSelector).toBe('.brand-name');
    expect(draft.imagesSelector).toBe('.gallery img');
  });

  it('maps customSelectors from the profile', () => {
    const profile = makeProfile();
    const draft = profileToDraft(profile);

    expect(draft.customSelectors).toEqual({
      weightSelector: '.weight',
      flavorSelector: '.flavor',
    });
  });

  it('handles null and undefined selectors gracefully', () => {
    const profile = makeProfile({
      titleSelector: null,
      titleOptionalSelectors: undefined as unknown as string[],
      descriptionSelector: null,
      imagesSelector: null,
      customSelectors: undefined as unknown as Record<string, string>,
    });
    const draft = profileToDraft(profile);

    expect(draft.titleSelector).toBeNull();
    expect(draft.titleOptionalSelectors).toEqual([]);
    expect(draft.descriptionSelector).toBeNull();
    expect(draft.customSelectors).toEqual({});
  });

  it('sets productUrl to empty string', () => {
    const profile = makeProfile();
    const draft = profileToDraft(profile);
    expect(draft.productUrl).toBe('');
  });

  it('preserves sitemapPattern, shopifyJSONPath, variantStrategy, metadata', () => {
    const profile = makeProfile({
      sitemapProductUrlPattern: '/items/',
      shopifyJSONPath: true,
      variantSelectionStrategy: { containerSelector: '#options', optionType: 'dropdown' },
      customSelectorMetadata: { weightSelector: { unit: 'oz' } },
    });
    const draft = profileToDraft(profile);

    expect(draft.sitemapProductUrlPattern).toBe('/items/');
    expect(draft.shopifyJSONPath).toBe(true);
    expect(draft.variantSelectionStrategy).toEqual({ containerSelector: '#options', optionType: 'dropdown' });
    expect(draft.customSelectorMetadata).toEqual({ weightSelector: { unit: 'oz' } });
  });
});

// ─── draftToSavePayload ──────────────────────────────────────────────────────

describe('draftToSavePayload', () => {
  it('converts a filled draft to save payload', () => {
    const draft = createEmptyDraft({ domain: 'acmepet.com', runtime: 'rendered' });
    draft.titleSelector = 'h1.product-title';
    draft.titleOptionalSelectors = ['.subtitle', '.tagline'];
    draft.brandSelector = '.brand';
    draft.descriptionSelector = '.desc';
    draft.imagesSelector = '.gallery img';
    draft.customSelectors = { weightSelector: '.weight' };
    draft.sitemapProductUrlPattern = '/products/';
    draft.shopifyJSONPath = true;
    draft.variantSelectionStrategy = { containerSelector: '#opts' };
    draft.customSelectorMetadata = { weightSelector: { unit: 'oz' } };

    const payload = draftToSavePayload(draft);

    expect(payload.domain).toBe('acmepet.com');
    expect(payload.runtime).toBe('rendered');
    expect(payload.titleSelector).toBe('h1.product-title');
    expect(payload.titleOptionalSelectors).toEqual(['.subtitle', '.tagline']);
    expect(payload.brandSelector).toBe('.brand');
    expect(payload.descriptionSelector).toBe('.desc');
    expect(payload.imagesSelector).toBe('.gallery img');
    expect(payload.customSelectors).toEqual({ weightSelector: '.weight' });
    expect(payload.sitemapProductUrlPattern).toBe('/products/');
    expect(payload.shopifyJSONPath).toBe(true);
    expect(payload.variantSelectionStrategy).toEqual({ containerSelector: '#opts' });
    expect(payload.customSelectorMetadata).toEqual({ weightSelector: { unit: 'oz' } });
  });

  it('normalizes empty core selectors to null', () => {
    const draft = createEmptyDraft({ domain: 'acmepet.com' });
    draft.titleSelector = '';
    draft.brandSelector = '   ';

    const payload = draftToSavePayload(draft);

    expect(payload.titleSelector).toBeNull();
    expect(payload.brandSelector).toBeNull();
  });

  it('omits empty custom selectors', () => {
    const draft = createEmptyDraft({ domain: 'acmepet.com' });
    draft.customSelectors = { flavor: '  ', weight: '.weight' };

    const payload = draftToSavePayload(draft);

    // weight stays, flavor is omitted, and customSelectors is not undefined
    expect(payload.customSelectors).toEqual({ weight: '.weight' });
  });

  it('sets customSelectors to undefined when all are empty', () => {
    const draft = createEmptyDraft({ domain: 'acmepet.com' });
    draft.customSelectors = { flavor: '', weight: '   ' };

    const payload = draftToSavePayload(draft);

    expect(payload.customSelectors).toBeUndefined();
  });

  it('filters titleOptionalSelectors to non-empty strings', () => {
    const draft = createEmptyDraft({ domain: 'acmepet.com' });
    draft.titleOptionalSelectors = ['.sub', '', ' .tag  ', ''];

    const payload = draftToSavePayload(draft);

    expect(payload.titleOptionalSelectors).toEqual(['.sub', ' .tag  ']);
  });
});

// ─── draftToValidatePayload ──────────────────────────────────────────────────

describe('draftToValidatePayload', () => {
  it('includes core and custom selectors flattened in selectors map', () => {
    const draft = createEmptyDraft({ domain: 'acmepet.com', runtime: 'rendered' });
    draft.titleSelector = 'h1';
    draft.descriptionSelector = '.desc';
    draft.customSelectors = { weightSelector: '.weight' };

    const samples = [
      { id: 's1', url: 'https://acmepet.com/p/1', confirmed: true },
    ];

    const payload = draftToValidatePayload(draft, samples);

    expect(payload.profileDraft.selectors).toEqual({
      titleSelector: 'h1',
      brandSelector: null,
      descriptionSelector: '.desc',
      imagesSelector: null,
      priceSelector: null,
      weightSelector: '.weight',
    });
    expect(payload.profileDraft.runtime).toBe('rendered');
    expect(payload.profileDraft.titleOptionalSelectors).toEqual([]);
    expect(payload.samples).toHaveLength(1);
    expect(payload.samples[0].url).toBe('https://acmepet.com/p/1');
    expect(payload.samples[0].confirmed).toBe(true);
  });

  it('includes expected name in samples when provided', () => {
    const draft = createEmptyDraft({ domain: 'acmepet.com' });
    const samples = [
      { id: 's1', url: 'https://acmepet.com/p/1', confirmed: true, expectedName: 'Premium Dog Food' },
    ];

    const payload = draftToValidatePayload(draft, samples);

    expect(payload.samples[0].expectedName).toBe('Premium Dog Food');
  });

  it('fills in empty arrays for urlPatterns, pageStructureSignals, warnings', () => {
    const draft = createEmptyDraft({ domain: 'acmepet.com' });
    const payload = draftToValidatePayload(draft, []);

    expect(payload.profileDraft.urlPatterns).toEqual([]);
    expect(payload.profileDraft.pageStructureSignals).toEqual([]);
    expect(payload.profileDraft.warnings).toEqual([]);
    expect(payload.profileDraft.imageRules).toEqual({});
  });
});

// ─── draftToTestPayload ──────────────────────────────────────────────────────

describe('draftToTestPayload', () => {
  it('maps all fields to the test payload', () => {
    const draft = createEmptyDraft({
      domain: 'acmepet.com',
      productUrl: 'https://acmepet.com/p/1',
    });
    draft.titleSelector = 'h1';
    draft.titleOptionalSelectors = ['.sub'];
    draft.brandSelector = '.brand';
    draft.descriptionSelector = '.desc';
    draft.imagesSelector = '.gallery';
    draft.priceSelector = '.price';
    draft.shopifyJSONPath = true;
    draft.customSelectors = { weightSelector: '.weight' };

    const payload = draftToTestPayload(draft);

    expect(payload.url).toBe('https://acmepet.com/p/1');
    expect(payload.titleSelector).toBe('h1');
    expect(payload.titleOptionalSelectors).toEqual(['.sub']);
    expect(payload.brandSelector).toBe('.brand');
    expect(payload.descriptionSelector).toBe('.desc');
    expect(payload.imagesSelector).toBe('.gallery');
    expect(payload.priceSelector).toBeNull();
    expect(payload.shopifyJSONPath).toBe(true);
    expect(payload.customSelectors).toEqual({ weightSelector: '.weight' });
  });
});

// ─── draftToSelectorMap ──────────────────────────────────────────────────────

describe('draftToSelectorMap', () => {
  it('returns flat map of all selectors', () => {
    const draft = createEmptyDraft({ domain: 'acmepet.com' });
    draft.titleSelector = 'h1';
    draft.brandSelector = null;
    draft.imagesSelector = '.gallery';
    draft.customSelectors = { weightSelector: '.weight' };

    const map = draftToSelectorMap(draft);

    expect(map).toEqual({
      titleSelector: 'h1',
      brandSelector: null,
      descriptionSelector: null,
      imagesSelector: '.gallery',
      priceSelector: null,
      weightSelector: '.weight',
    });
  });
});

// ─── Helper functions ────────────────────────────────────────────────────────

describe('emptyToNull', () => {
  it('returns null for undefined', () => {
    expect(emptyToNull(undefined)).toBeNull();
  });
  it('returns null for null', () => {
    expect(emptyToNull(null)).toBeNull();
  });
  it('returns null for empty string', () => {
    expect(emptyToNull('')).toBeNull();
  });
  it('returns null for whitespace-only string', () => {
    expect(emptyToNull('   ')).toBeNull();
  });
  it('keeps original (non-empty) value as-is (does not trim)', () => {
    expect(emptyToNull('  h1  ')).toBe('  h1  ');
  });
});

describe('omitEmptyValues', () => {
  it('removes empty string values', () => {
    const result = omitEmptyValues({ a: 'val', b: '', c: '   ', d: 'keep' });
    expect(result).toEqual({ a: 'val', d: 'keep' });
  });
  it('returns empty object when all values empty', () => {
    const result = omitEmptyValues({ a: '', b: ' ' });
    expect(result).toEqual({});
  });
});
