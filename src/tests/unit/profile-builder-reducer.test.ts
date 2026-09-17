/**
 * Unit tests for `src/client/components/profile-builder/profileBuilderReducer.ts`.
 *
 * Pure reducer and field status derivation — no DOM, no API, no React.
 * Runs under vitest (environment: 'node').
 */

import { describe, it, expect } from 'vitest';
import {
  profileBuilderReducer,
  createInitialState,
  deriveFieldStatus,
  ProfileBuilderAction,
} from '@/client/components/profile-builder/profileBuilderReducer';
import type { ProfileBuilderState } from '@/client/components/profile-builder/profileBuilderTypes';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function initial(overrides?: Partial<ProfileBuilderState>): ProfileBuilderState {
  return { ...createInitialState(), ...overrides };
}

function filledDraftState(): ProfileBuilderState {
  const s = initial({ draft: { ...createInitialState().draft, domain: 'acmepet.com', productUrl: 'https://acmepet.com/p/1' } });
  return s;
}

function sampleProfile() {
  return {
    id: 'prof-1',
    domain: 'acmepet.com',
    titleSelector: 'h1',
    titleOptionalSelectors: [] as string[],
    brandSelector: null as string | null,
    descriptionSelector: null as string | null,
    imagesSelector: null as string | null,
    priceSelector: null as string | null,
    customSelectors: {} as Record<string, string>,
    sitemapProductUrlPattern: null as string | null,
    shopifyJSONPath: false,
    variantSelectionStrategy: null as Record<string, unknown> | null,
    customSelectorMetadata: {} as Record<string, unknown>,
    runtime: 'rendered' as 'static' | 'rendered',
    profileType: 'brand' as const,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
  };
}

// ─── Initial State ───────────────────────────────────────────────────────────

describe('createInitialState', () => {
  it('creates empty draft with default runtime rendered', () => {
    const s = createInitialState();
    expect(s.draft.domain).toBe('');
    expect(s.draft.runtime).toBe('rendered');
    expect(s.draft.productUrl).toBe('');
    expect(s.dirty).toBe(false);
    expect(s.activeProfile).toBeNull();
    expect(s.validation).toBeNull();
    expect(s.snapshot).toBeNull();
    expect(s.extractionPreview).toBeNull();
  });

  it('accepts initialDomain and initialProductUrl', () => {
    const s = createInitialState({ initialDomain: 'example.com', initialProductUrl: 'https://example.com/p/1' });
    expect(s.draft.domain).toBe('example.com');
    expect(s.draft.productUrl).toBe('https://example.com/p/1');
  });

  it('builds field state for core fields', () => {
    const s = createInitialState();
    expect(s.fields['titleSelector']).toBeDefined();
    expect(s.fields['titleOptionalSelectors']).toBeDefined();
    expect(s.fields['descriptionSelector']).toBeDefined();
    expect(s.fields['imagesSelector']).toBeDefined();
    expect(Object.keys(s.fields)).toHaveLength(4);
  });

  it('collapses nutrition, details, variants by default', () => {
    const s = createInitialState();
    expect(s.collapsedCategories.identity).toBe(false);
    expect(s.collapsedCategories.media).toBe(false);
    expect(s.collapsedCategories.description).toBe(false);
    expect(s.collapsedCategories.nutrition).toBe(true);
    expect(s.collapsedCategories.details).toBe(true);
    expect(s.collapsedCategories.variants).toBe(true);
  });

  it('has initial request states with loading false', () => {
    const s = createInitialState();
    for (const key of ['loadProfiles', 'snapshot', 'fetchHtml', 'generateSelector', 'preview', 'validate', 'save']) {
      const req = s.requests[key as keyof typeof s.requests];
      expect(req.loading).toBe(false);
      expect(req.error).toBeNull();
    }
  });
});

// ─── Domain ──────────────────────────────────────────────────────────────────

describe('domain/set', () => {
  it('updates the domain and marks dirty', () => {
    const s = initial();
    const next = profileBuilderReducer(s, { type: 'domain/set', domain: 'acmepet.com' });
    expect(next.draft.domain).toBe('acmepet.com');
    expect(next.dirty).toBe(true);
  });
});

// ─── activeProfile/set ───────────────────────────────────────────────────────

describe('activeProfile/set', () => {
  it('stores the active profile', () => {
    const p = sampleProfile();
    const s = initial();
    const next = profileBuilderReducer(s, { type: 'activeProfile/set', profile: p });
    expect(next.activeProfile?.id).toBe('prof-1');
  });

  it('clears the active profile when null', () => {
    const s = initial({ activeProfile: sampleProfile() });
    const next = profileBuilderReducer(s, { type: 'activeProfile/set', profile: null });
    expect(next.activeProfile).toBeNull();
  });
});

// ─── Draft Hydrate ───────────────────────────────────────────────────────────

describe('draft/hydrateFromProfile', () => {
  it('hydrates draft from an ExtractorProfile', () => {
    const s = initial();
    const p = { ...sampleProfile(), titleSelector: 'h1.product-title', brandSelector: '.brand' };

    const next = profileBuilderReducer(s, { type: 'draft/hydrateFromProfile', profile: p });

    expect(next.draft.domain).toBe('acmepet.com');
    expect(next.draft.titleSelector).toBe('h1.product-title');
    expect(next.draft.brandSelector).toBe('.brand');
    expect(next.draft.customSelectors).toEqual({});
    expect(next.dirty).toBe(false);
  });

  it('preserves existing productUrl', () => {
    const s = initial({ draft: { ...initial().draft, productUrl: 'https://acmepet.com/p/1' } });
    const next = profileBuilderReducer(s, { type: 'draft/hydrateFromProfile', profile: sampleProfile() });
    expect(next.draft.productUrl).toBe('https://acmepet.com/p/1');
  });
});

// ─── draft/reset ─────────────────────────────────────────────────────────────

describe('draft/reset', () => {
  it('resets draft to empty, preserves domain, clears derived state', () => {
    const s = filledDraftState();
    s.snapshot = { url: '', finalUrl: '', htmlRef: null, screenshotRef: null, jsonLd: [], embeddedProductData: [], imageCandidates: [], pageStructureSignals: [], warnings: [] };
    s.pageHtml = '<html></html>';
    s.samples = [{ id: 's1', url: 'https://acmepet.com/p/1', confirmed: true }];
    s.validation = { summary: { sampleCount: 0, confirmedSampleCount: 0, passingSamples: 0, failingSamples: 0, variantSamplesPassing: 0 }, results: [] };
    s.dirty = true;

    const next = profileBuilderReducer(s, { type: 'draft/reset' });

    expect(next.draft.domain).toBe('acmepet.com'); // domain preserved
    expect(next.draft.titleSelector).toBeNull();
    expect(next.draft.productUrl).toBe(''); // reset to empty
    expect(next.snapshot).toBeNull();
    expect(next.pageHtml).toBeNull();
    expect(next.samples).toEqual([]);
    expect(next.validation).toBeNull();
    expect(next.dirty).toBe(false);
  });
});

// ─── Runtime ─────────────────────────────────────────────────────────────────

describe('runtime/set', () => {
  it('updates runtime and clears preview and validation', () => {
    const s = filledDraftState();
    s.extractionPreview = { title: 'test' };
    s.validation = { summary: { sampleCount: 1, confirmedSampleCount: 1, passingSamples: 1, failingSamples: 0, variantSamplesPassing: 0 }, results: [] };
    s.dirty = false;

    const next = profileBuilderReducer(s, { type: 'runtime/set', runtime: 'static' });

    expect(next.draft.runtime).toBe('static');
    expect(next.extractionPreview).toBeNull();
    expect(next.validation).toBeNull();
    expect(next.dirty).toBe(true);
  });
});

// ─── Product URL ─────────────────────────────────────────────────────────────

describe('productUrl/set', () => {
  it('updates URL, clears snapshot, pageHtml, preview, and validation', () => {
    const s = filledDraftState();
    s.snapshot = { url: '', finalUrl: '', htmlRef: null, screenshotRef: null, jsonLd: [], embeddedProductData: [], imageCandidates: [], pageStructureSignals: [], warnings: [] };
    s.pageHtml = '<html></html>';
    s.extractionPreview = { title: 'test' };
    s.validation = { summary: { sampleCount: 1, confirmedSampleCount: 1, passingSamples: 1, failingSamples: 0, variantSamplesPassing: 0 }, results: [] };

    const next = profileBuilderReducer(s, { type: 'productUrl/set', url: 'https://acmepet.com/p/2' });

    expect(next.draft.productUrl).toBe('https://acmepet.com/p/2');
    expect(next.snapshot).toBeNull();
    expect(next.pageHtml).toBeNull();
    expect(next.extractionPreview).toBeNull();
    expect(next.validation).toBeNull();
    expect(next.requests.snapshot.loading).toBe(false);
    expect(next.requests.preview.loading).toBe(false);
    expect(next.requests.validate.loading).toBe(false);
  });
});

// ─── Field Selector Changed ──────────────────────────────────────────────────

describe('field/selectorChanged', () => {
  it('updates titleSelector in draft and field state, marks dirty', () => {
    const s = filledDraftState();
    const next = profileBuilderReducer(s, { type: 'field/selectorChanged', key: 'titleSelector', selector: 'h1.product-title' });

    expect(next.draft.titleSelector).toBe('h1.product-title');
    expect(next.fields['titleSelector'].selector).toBe('h1.product-title');
    expect(next.fields['titleSelector'].status).toBe('assigned');
    expect(next.dirty).toBe(true);
  });

  it('updates custom selector via draft.customSelectors', () => {
    const s = filledDraftState();
    const next = profileBuilderReducer(s, { type: 'field/selectorChanged', key: 'flavorSelector', selector: '.flavor' });

    expect(next.draft.customSelectors['flavorSelector']).toBe('.flavor');
    expect(next.fields['flavorSelector'].selector).toBe('.flavor');
    expect(next.dirty).toBe(true);
  });

  it('sets status to unassigned when selector is cleared', () => {
    const s = filledDraftState();
    s.fields['titleSelector'] = { key: 'titleSelector', selector: 'h1', status: 'assigned', warnings: [] };

    const next = profileBuilderReducer(s, { type: 'field/selectorChanged', key: 'titleSelector', selector: '' });

    expect(next.fields['titleSelector'].status).toBe('unassigned');
    expect(next.dirty).toBe(true);
  });
});

// ─── titleOptionalSelectors ──────────────────────────────────────────────────

describe('titleOptional/add', () => {
  it('appends an empty selector when no value given', () => {
    const s = filledDraftState();
    const next = profileBuilderReducer(s, { type: 'titleOptional/add' });

    expect(next.draft.titleOptionalSelectors).toEqual(['']);
    expect(next.dirty).toBe(true);
  });

  it('appends a selector when value given', () => {
    const s = filledDraftState();
    s.draft.titleOptionalSelectors = ['.subtitle'];

    const next = profileBuilderReducer(s, { type: 'titleOptional/add', selector: '.tagline' });

    expect(next.draft.titleOptionalSelectors).toEqual(['.subtitle', '.tagline']);
  });
});

describe('titleOptional/update', () => {
  it('updates a selector at a specific index', () => {
    const s = filledDraftState();
    s.draft.titleOptionalSelectors = ['.sub', '.tag'];

    const next = profileBuilderReducer(s, { type: 'titleOptional/update', index: 1, selector: '.tagline' });

    expect(next.draft.titleOptionalSelectors).toEqual(['.sub', '.tagline']);
    expect(next.dirty).toBe(true);
  });

  it('does nothing when index is out of range', () => {
    const s = filledDraftState();
    s.draft.titleOptionalSelectors = ['.sub'];

    const next = profileBuilderReducer(s, { type: 'titleOptional/update', index: 5, selector: '.x' });

    expect(next.draft.titleOptionalSelectors).toEqual(['.sub']);
  });
});

describe('titleOptional/remove', () => {
  it('removes a selector at a specific index', () => {
    const s = filledDraftState();
    s.draft.titleOptionalSelectors = ['.sub', '.tag', '.extra'];

    const next = profileBuilderReducer(s, { type: 'titleOptional/remove', index: 1 });

    expect(next.draft.titleOptionalSelectors).toEqual(['.sub', '.extra']);
    expect(next.dirty).toBe(true);
  });
});

// ─── Custom Fields ───────────────────────────────────────────────────────────

describe('customField/add', () => {
  it('adds a blank custom field selector entry', () => {
    const s = filledDraftState();
    const next = profileBuilderReducer(s, { type: 'customField/add', key: 'flavorSelector' });

    expect(next.customFieldOrder).toEqual(['flavorSelector']);
    expect(next.draft.customSelectors['flavorSelector']).toBe('');
    expect(next.dirty).toBe(true);
  });

  it('does not duplicate existing custom fields', () => {
    const s = filledDraftState();
    s.customFieldOrder = ['flavorSelector'];
    s.draft.customSelectors = { flavorSelector: '.flavor' };

    const next = profileBuilderReducer(s, { type: 'customField/add', key: 'flavorSelector' });

    expect(next.customFieldOrder).toEqual(['flavorSelector']);
    // Should not add a duplicate
  });
});

describe('customField/remove', () => {
  it('removes a custom field selector entry', () => {
    const s = filledDraftState();
    s.customFieldOrder = ['flavorSelector', 'weightSelector'];
    s.draft.customSelectors = { flavorSelector: '.flavor', weightSelector: '.weight' };

    const next = profileBuilderReducer(s, { type: 'customField/remove', key: 'flavorSelector' });

    expect(next.customFieldOrder).toEqual(['weightSelector']);
    expect(next.draft.customSelectors).toEqual({ weightSelector: '.weight' });
    expect(next.dirty).toBe(true);
  });
});

// ─── Preview ─────────────────────────────────────────────────────────────────

describe('preview/succeeded', () => {
  it('stores extracted preview', () => {
    const s = filledDraftState();
    const extracted = { title: 'Product 1', brand: 'Acme', price: '$19.99', images: ['https://img.jpg'], customFields: {} };

    const next = profileBuilderReducer(s, { type: 'preview/succeeded', extracted });

    expect(next.extractionPreview).toEqual(extracted);
    expect(next.requests.preview.loading).toBe(false);
    expect(next.requests.preview.success).toBe(true);
  });
});

describe('preview/failed', () => {
  it('preserves existing preview and selectors', () => {
    const s = filledDraftState();
    s.extractionPreview = { title: 'Old preview' };

    const next = profileBuilderReducer(s, { type: 'preview/failed', error: 'Network error' });

    expect(next.extractionPreview).toEqual({ title: 'Old preview' });
    expect(next.requests.preview.error).toBe('Network error');
  });
});

// ─── Validation ──────────────────────────────────────────────────────────────

describe('validation/succeeded', () => {
  it('stores validation results', () => {
    const s = filledDraftState();
    const validation = {
      summary: { sampleCount: 2, confirmedSampleCount: 1, passingSamples: 2, failingSamples: 0, variantSamplesPassing: 0 },
      results: [
        {
          sampleUrl: 'https://acmepet.com/p/1',
          confirmed: true,
          fieldResults: { titleSelector: { status: 'pass' as const, extractedValue: 'Prod 1', warnings: [] as string[] } },
          imageResults: { primaryImageMatch: true, candidateCount: 3, warnings: [] as string[] },
          variantResult: null,
        },
      ],
    };

    const next = profileBuilderReducer(s, { type: 'validation/succeeded', validation });

    expect(next.validation).toEqual(validation);
    expect(next.requests.validate.success).toBe(true);
  });
});

describe('validation/failed', () => {
  it('preserves previous validation result on failure', () => {
    const oldValidation = {
      summary: { sampleCount: 1, confirmedSampleCount: 1, passingSamples: 1, failingSamples: 0, variantSamplesPassing: 0 },
      results: [{ sampleUrl: 'https://acmepet.com/p/1', confirmed: true, fieldResults: { titleSelector: { status: 'pass' as const, extractedValue: 'Prod', warnings: [] as string[] } }, imageResults: { primaryImageMatch: true, candidateCount: 1, warnings: [] as string[] }, variantResult: null }],
    };
    const s = filledDraftState();
    s.validation = oldValidation;

    const next = profileBuilderReducer(s, { type: 'validation/failed', error: 'API timeout' });

    expect(next.validation).toEqual(oldValidation);
    expect(next.requests.validate.error).toBe('API timeout');
    expect(next.requests.validate.success).toBe(false);
  });
});

// ─── Save ────────────────────────────────────────────────────────────────────

describe('save/succeeded', () => {
  it('replaces activeProfile, clears dirty, updates profiles list', () => {
    const s = filledDraftState();
    s.dirty = true;
    const saved = { ...sampleProfile(), titleSelector: 'h1.new' };

    const next = profileBuilderReducer(s, { type: 'save/succeeded', profile: saved });

    expect(next.activeProfile?.titleSelector).toBe('h1.new');
    expect(next.dirty).toBe(false);
    expect(next.lastSavedProfileId).toBe('prof-1');
    expect(next.requests.save.success).toBe(true);
  });

  it('appends profile when id not found in existing profiles', () => {
    const s = filledDraftState();
    s.profiles = [];
    const saved = sampleProfile();

    const next = profileBuilderReducer(s, { type: 'save/succeeded', profile: saved });

    expect(next.profiles).toHaveLength(1);
    expect(next.profiles[0].id).toBe('prof-1');
  });
});

describe('save/failed', () => {
  it('keeps draft dirty so operator can retry', () => {
    const s = filledDraftState();
    s.dirty = true;

    const next = profileBuilderReducer(s, { type: 'save/failed', error: 'Server error' });

    expect(next.dirty).toBe(true);
    expect(next.requests.save.error).toBe('Server error');
  });
});

// ─── Samples ─────────────────────────────────────────────────────────────────

describe('sample/add', () => {
  it('adds a sample and clears validation', () => {
    const s = filledDraftState();
    s.validation = { summary: { sampleCount: 1, confirmedSampleCount: 1, passingSamples: 1, failingSamples: 0, variantSamplesPassing: 0 }, results: [] };
    const sample = { id: 's1', url: 'https://acmepet.com/p/1', confirmed: true };

    const next = profileBuilderReducer(s, { type: 'sample/add', sample });

    expect(next.samples).toHaveLength(1);
    expect(next.samples[0].id).toBe('s1');
    expect(next.validation).toBeNull();
  });
});

describe('sample/remove', () => {
  it('removes a sample by id and clears validation', () => {
    const s = filledDraftState();
    s.samples = [
      { id: 's1', url: 'https://acmepet.com/p/1', confirmed: true },
      { id: 's2', url: 'https://acmepet.com/p/2', confirmed: false },
    ];

    const next = profileBuilderReducer(s, { type: 'sample/remove', id: 's1' });

    expect(next.samples).toHaveLength(1);
    expect(next.samples[0].id).toBe('s2');
    expect(next.validation).toBeNull();
  });
});

// ─── Field Selector Evaluated ───────────────────────────────────────────────

describe('field/selectorEvaluated', () => {
  it('updates field state with local evaluation result', () => {
    const s = filledDraftState();
    s.fields['titleSelector'] = { key: 'titleSelector', selector: 'h1', status: 'assigned', warnings: [] };

    const result = { status: 'warning' as const, extractedPreview: 'Prod', matchCount: 2, warnings: ['Multiple matches'] };

    const next = profileBuilderReducer(s, { type: 'field/selectorEvaluated', key: 'titleSelector', result });

    expect(next.fields['titleSelector'].status).toBe('warning');
    expect(next.fields['titleSelector'].extractedPreview).toBe('Prod');
    expect(next.fields['titleSelector'].matchCount).toBe(2);
    expect(next.fields['titleSelector'].warnings).toEqual(['Multiple matches']);
  });
});

// ─── Category Toggle ─────────────────────────────────────────────────────────

describe('category/toggle', () => {
  it('toggles collapsed state for a category', () => {
    const s = initial();
    expect(s.collapsedCategories.identity).toBe(false);

    const next = profileBuilderReducer(s, { type: 'category/toggle', category: 'identity' });
    expect(next.collapsedCategories.identity).toBe(true);

    const next2 = profileBuilderReducer(next, { type: 'category/toggle', category: 'identity' });
    expect(next2.collapsedCategories.identity).toBe(false);
  });
});

// ─── Snapshot ───────────────────────────────────────────────────────────────

describe('snapshot/succeeded', () => {
  it('stores snapshot response', () => {
    const s = filledDraftState();
    const snap = { url: 'https://acmepet.com/p/1', finalUrl: 'https://acmepet.com/p/1', htmlRef: null, screenshotRef: null, jsonLd: [], embeddedProductData: [], imageCandidates: [], pageStructureSignals: [], warnings: [] };

    const next = profileBuilderReducer(s, { type: 'snapshot/succeeded', snapshot: snap });

    expect(next.snapshot).toEqual(snap);
    expect(next.requests.snapshot.success).toBe(true);
  });
});

// ─── deriveFieldStatus ───────────────────────────────────────────────────────

describe('deriveFieldStatus', () => {
  it('returns unassigned for empty selector', () => {
    const status = deriveFieldStatus({ selector: '', fieldKey: 'titleSelector' });
    expect(status).toBe('unassigned');
  });

  it('returns unassigned for whitespace-only selector', () => {
    const status = deriveFieldStatus({ selector: '   ', fieldKey: 'titleSelector' });
    expect(status).toBe('unassigned');
  });

  it('returns tested when a preview exists with a value', () => {
    const status = deriveFieldStatus({
      selector: 'h1',
      previewResult: { title: 'Product Name' },
      fieldKey: 'titleSelector',
    });
    expect(status).toBe('tested');
  });

  it('returns assigned when no validation, no preview, no local result', () => {
    const status = deriveFieldStatus({ selector: 'h1', fieldKey: 'titleSelector' });
    expect(status).toBe('assigned');
  });

  it('returns failed when any validation sample fails', () => {
    const status = deriveFieldStatus({
      selector: 'h1',
      validation: {
        summary: { sampleCount: 2, confirmedSampleCount: 2, passingSamples: 1, failingSamples: 1, variantSamplesPassing: 0 },
        results: [
          { sampleUrl: 'https://acmepet.com/p/1', confirmed: true, fieldResults: { titleSelector: { status: 'pass', extractedValue: 'Prod', warnings: [] as string[] } }, imageResults: { primaryImageMatch: true, candidateCount: 1, warnings: [] as string[] }, variantResult: null },
          { sampleUrl: 'https://acmepet.com/p/2', confirmed: true, fieldResults: { titleSelector: { status: 'fail', extractedValue: '', warnings: ['Empty'] as string[] } }, imageResults: { primaryImageMatch: true, candidateCount: 1, warnings: [] as string[] }, variantResult: null },
        ],
      },
      fieldKey: 'titleSelector',
    });
    expect(status).toBe('failed');
  });

  it('returns warning when validation has warns but no fails', () => {
    const status = deriveFieldStatus({
      selector: 'h1',
      validation: {
        summary: { sampleCount: 1, confirmedSampleCount: 1, passingSamples: 0, failingSamples: 0, variantSamplesPassing: 0 },
        results: [
          { sampleUrl: 'https://acmepet.com/p/1', confirmed: true, fieldResults: { titleSelector: { status: 'warning', extractedValue: 'Prod', warnings: ['Short'] as string[] } }, imageResults: { primaryImageMatch: true, candidateCount: 1, warnings: [] as string[] }, variantResult: null },
        ],
      },
      fieldKey: 'titleSelector',
    });
    expect(status).toBe('warning');
  });

  it('returns validated when all samples pass', () => {
    const status = deriveFieldStatus({
      selector: 'h1',
      validation: {
        summary: { sampleCount: 2, confirmedSampleCount: 2, passingSamples: 2, failingSamples: 0, variantSamplesPassing: 0 },
        results: [
          { sampleUrl: 'https://acmepet.com/p/1', confirmed: true, fieldResults: { titleSelector: { status: 'pass', extractedValue: 'Prod', warnings: [] as string[] } }, imageResults: { primaryImageMatch: true, candidateCount: 1, warnings: [] as string[] }, variantResult: null },
          { sampleUrl: 'https://acmepet.com/p/2', confirmed: true, fieldResults: { titleSelector: { status: 'pass', extractedValue: 'Prod 2', warnings: [] as string[] } }, imageResults: { primaryImageMatch: true, candidateCount: 1, warnings: [] as string[] }, variantResult: null },
        ],
      },
      fieldKey: 'titleSelector',
    });
    expect(status).toBe('validated');
  });

  it('fail wins over pass in mixed results', () => {
    const status = deriveFieldStatus({
      selector: 'h1',
      validation: {
        summary: { sampleCount: 2, confirmedSampleCount: 2, passingSamples: 1, failingSamples: 1, variantSamplesPassing: 0 },
        results: [
          { sampleUrl: 'https://acmepet.com/p/1', confirmed: true, fieldResults: { titleSelector: { status: 'pass', extractedValue: 'Prod', warnings: [] as string[] } }, imageResults: { primaryImageMatch: true, candidateCount: 1, warnings: [] as string[] }, variantResult: null },
          { sampleUrl: 'https://acmepet.com/p/2', confirmed: true, fieldResults: { titleSelector: { status: 'fail', extractedValue: '', warnings: ['Empty'] as string[] } }, imageResults: { primaryImageMatch: true, candidateCount: 1, warnings: [] as string[] }, variantResult: null },
        ],
      },
      fieldKey: 'titleSelector',
    });
    // fail beats pass
    expect(status).toBe('failed');
  });

  it('returns failed when local result is failed (no validation)', () => {
    const status = deriveFieldStatus({
      selector: 'h1',
      localResult: { status: 'failed', matchCount: 0, warnings: ['No match'], extractedPreview: null },
      fieldKey: 'titleSelector',
    });
    expect(status).toBe('failed');
  });

  it('returns warning when local result is warning (no validation)', () => {
    const status = deriveFieldStatus({
      selector: 'h1',
      localResult: { status: 'warning', matchCount: 2, warnings: ['Multiple matches'], extractedPreview: 'Prod' },
      fieldKey: 'titleSelector',
    });
    expect(status).toBe('warning');
  });

  it('image selector reports tested only when images array is non-empty', () => {
    const statusWithImages = deriveFieldStatus({
      selector: '.gallery',
      previewResult: { images: ['https://img.jpg'] },
      fieldKey: 'imagesSelector',
    });
    expect(statusWithImages).toBe('tested');

    const statusNoImages = deriveFieldStatus({
      selector: '.gallery',
      previewResult: { title: 'No images here' },
      fieldKey: 'imagesSelector',
    });
    expect(statusNoImages).toBe('assigned');
  });

  it('returns tested when custom field has value in preview', () => {
    const status = deriveFieldStatus({
      selector: '.flavor',
      previewResult: { customFields: { flavorSelector: 'Chicken' } },
      fieldKey: 'flavorSelector',
    });
    expect(status).toBe('tested');
  });
});

// ─── Image Review Attestation ───────────────────────────────────────────────

describe('imageReview/set', () => {
  it('defaults to false and records an explicit attestation', () => {
    expect(initial().imagePreviewsReviewed).toBe(false);
    const next = profileBuilderReducer(initial(), { type: 'imageReview/set', reviewed: true });
    expect(next.imagePreviewsReviewed).toBe(true);
    expect(next.dirty).toBe(true);
  });

  it('voids the attestation when samples change (fail-closed per sample set)', () => {
    const attested = profileBuilderReducer(initial(), { type: 'imageReview/set', reviewed: true });
    const added = profileBuilderReducer(attested, {
      type: 'sample/add',
      sample: { id: 's1', url: 'https://acmepet.com/p/1', confirmed: true },
    });
    expect(added.imagePreviewsReviewed).toBe(false);
    const reattested = profileBuilderReducer(added, { type: 'imageReview/set', reviewed: true });
    const removed = profileBuilderReducer(reattested, { type: 'sample/remove', id: 's1' });
    expect(removed.imagePreviewsReviewed).toBe(false);
  });

  it('voids the attestation when the images selector changes', () => {
    const attested = profileBuilderReducer(initial(), { type: 'imageReview/set', reviewed: true });
    const changed = profileBuilderReducer(attested, {
      type: 'field/selectorChanged',
      key: 'imagesSelector',
      selector: '.new-gallery img',
    });
    expect(changed.imagePreviewsReviewed).toBe(false);
    const titleChanged = profileBuilderReducer(attested, {
      type: 'field/selectorChanged',
      key: 'titleSelector',
      selector: 'h1.new',
    });
    expect(titleChanged.imagePreviewsReviewed).toBe(true);
  });

  it('resets on draft reset and profile hydration', () => {
    const attested = profileBuilderReducer(initial(), { type: 'imageReview/set', reviewed: true });
    expect(profileBuilderReducer(attested, { type: 'draft/reset' }).imagePreviewsReviewed).toBe(false);
    expect(
      profileBuilderReducer(attested, { type: 'draft/hydrateFromProfile', profile: sampleProfile() }).imagePreviewsReviewed,
    ).toBe(false);
  });
});
