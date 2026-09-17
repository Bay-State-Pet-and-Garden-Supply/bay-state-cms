import { describe, expect, it } from 'vitest';
import { createEmptyDraft, draftToVersionPayload } from '../../client/components/profile-builder/profileBuilderMapping';

describe('Profile Builder version payload', () => {
  it('records explicit image review on the saved version, never by default', () => {
    const draft = createEmptyDraft({ domain: 'example.com' });
    expect(draftToVersionPayload(draft, false).validationSummary.imageRuleOk).toBe(false);
    expect(draftToVersionPayload(draft, true).validationSummary.imageRuleOk).toBe(true);
  });

  it('carries the complete executable configuration (activation never wipes custom/variant config)', () => {
    const draft = createEmptyDraft({ domain: 'example.com', runtime: 'static' });
    draft.titleSelector = 'h1';
    draft.titleOptionalSelectors = ['.subtitle'];
    draft.descriptionSelector = '.desc';
    draft.imagesSelector = '.gallery img';
    draft.customSelectors = { flavorSelector: '.flavor', empty: '   ' };
    draft.sitemapProductUrlPattern = '/products/';
    draft.shopifyJSONPath = true;
    draft.variantSelectionStrategy = { containerSelector: 'select#size', axes: ['size'] };
    draft.customSelectorMetadata = { flavorSelector: { unit: 'text' } };

    const payload = draftToVersionPayload(draft, true, { sampleCount: 3 });

    expect(payload.domain).toBe('example.com');
    expect(payload.runtime).toBe('static');
    expect(payload.selectors.titleSelector).toBe('h1');
    expect(payload.selectors.titleOptionalSelectors).toEqual(['.subtitle']);
    expect(payload.selectors.descriptionSelector).toBe('.desc');
    expect(payload.selectors.imagesSelector).toBe('.gallery img');
    // Empty custom values omitted, configured ones preserved.
    expect(payload.selectors.customSelectors).toEqual({ flavorSelector: '.flavor' });
    expect(payload.selectors.sitemapProductUrlPattern).toBe('/products/');
    expect(payload.selectors.shopifyJSONPath).toBe(true);
    expect(payload.selectors.variantSelectionStrategy).toEqual({ containerSelector: 'select#size', axes: ['size'] });
    expect(payload.selectors.customSelectorMetadata).toEqual({ flavorSelector: { unit: 'text' } });
    expect(payload.validationSummary).toEqual({ imageRuleOk: true, rowCount: 3 });
  });
});
