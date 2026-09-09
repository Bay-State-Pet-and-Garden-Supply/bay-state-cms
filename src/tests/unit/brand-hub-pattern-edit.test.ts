// story: e35s10 — Commit 12 RED: hub pattern edit not yet implemented
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock extractor profile repo before importing patternEdit
vi.mock('@/db/repositories/extractor-profile-repo', () => ({
  upsertProfile: vi.fn((domain: string, selectors: any) => ({ domain, ...selectors })),
  findProfileByDomain: vi.fn(),
}));

import { upsertProfile } from '../../db/repositories/extractor-profile-repo';
import { updateBrandHubPattern } from '../../onboarding/brand-hub/patternEdit';

describe('brand hub pattern edit — delegates to extractor-profile upsert', () => {
  beforeEach(() => {
    vi.mocked(upsertProfile).mockClear();
  });

  it('normalizes domain and delegates string pattern verbatim', () => {
    updateBrandHubPattern('https://www.Example.com/', '/products/');
    expect(upsertProfile).toHaveBeenCalledWith('example.com', { sitemapProductUrlPattern: '/products/' });
  });

  it('explicit null clears pattern but delegates verbatim', () => {
    updateBrandHubPattern('example.com', null);
    expect(upsertProfile).toHaveBeenCalledWith('example.com', { sitemapProductUrlPattern: null });
  });

  it('omitted (undefined) preserves existing pattern — delegates as undefined so repo preserves', () => {
    updateBrandHubPattern('example.com', undefined);
    expect(upsertProfile).toHaveBeenCalledWith('example.com', { sitemapProductUrlPattern: undefined });
  });

  it('normalizes https + www + path to bare lowercased domain before delegation', () => {
    updateBrandHubPattern('https://www.kongcompany.com/products/classic-red?x=1', '/shop/');
    expect(upsertProfile).toHaveBeenCalledWith('kongcompany.com', { sitemapProductUrlPattern: '/shop/' });
  });

  it('throws when domain normalizes to empty', () => {
    expect(() => updateBrandHubPattern('   ', '/products/')).toThrow();
  });
});
