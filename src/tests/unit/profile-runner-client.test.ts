import { describe, expect, it, vi } from 'vitest';

vi.mock('@/server/extraction-worker-client', () => ({
  trustedExtract: vi.fn(),
}));

import { trustedExtract } from '../../server/extraction-worker-client';
import { runProfileExtraction } from '../../onboarding/profile-runner-client';
import type { ExtractorProfile } from '../../db/repositories/extractor-profile-repo';

describe('runProfileExtraction image deduplication', () => {
  it('deduplicates and normalizes images returned by the extraction worker', async () => {
    const mockProfile: ExtractorProfile = {
      id: 'prof-123',
      domain: 'mywoof.com',
      titleSelector: 'h1',
      titleOptionalSelectors: [],
      priceSelector: null,
      descriptionSelector: null,
      brandSelector: null,
      imagesSelector: '.gallery',
      sitemapProductUrlPattern: null,
      shopifyJSONPath: false,
      customSelectors: {},
      variantSelectionStrategy: null,
      customSelectorMetadata: {},
      runtime: 'rendered',
      createdAt: '2026-07-04T00:00:00Z',
      updatedAt: '2026-07-04T00:00:00Z',
    };

    vi.mocked(trustedExtract).mockResolvedValueOnce({
      ok: true,
      data: {
        ok: true,
        extractionData: {
          title: 'Woof Fly-n-Feed',
          brand: 'Woof',
          description: 'Fun toy',
          price: '29.99',
          primaryImage: '//mywoof.com/cdn/shop/files/Woof_Fly-n-Feed_Gallery_1200x1200_1.png?v=1757965804&width=1200',
          additionalImages: [
            '//mywoof.com/cdn/shop/files/Woof_Fly-n-Feed_Gallery_1200x1200_1.png?v=1757965804&width=165',
            '//mywoof.com/cdn/shop/files/Woof_Fly-n-Feed_Gallery_1200x1200_1.png?v=1757965804&width=329',
            '//mywoof.com/cdn/shop/files/Woof_Fly-n-Feed_Gallery_1200x1200_3_0a05886a-ca80-4ad5-834b-790a163c0916.png?v=1760192970&width=1200',
            '//mywoof.com/cdn/shop/files/Woof_Fly-n-Feed_Gallery_1200x1200_3_0a05886a-ca80-4ad5-834b-790a163c0916.png?v=1760192970&width=165',
          ],
        },
        warnings: [],
      } as any,
    });

    const result = await runProfileExtraction({
      sourceUrl: 'https://mywoof.com/products/fly-n-feed',
      profile: mockProfile,
      expected: {
        name: 'Woof Fly-n-Feed',
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.primaryImage).toBe('https://mywoof.com/cdn/shop/files/Woof_Fly-n-Feed_Gallery_1200x1200_1.png?v=1757965804&width=1200');
      expect(result.data.additionalImages).toEqual([
        'https://mywoof.com/cdn/shop/files/Woof_Fly-n-Feed_Gallery_1200x1200_3_0a05886a-ca80-4ad5-834b-790a163c0916.png?v=1760192970&width=1200'
      ]);
    }
  });
});

describe('runProfileExtraction variantSelection forwarding', () => {
  it('forwards variantSelection when provided', async () => {
    vi.clearAllMocks();
    const { runProfileExtraction } = await import('../../onboarding/profile-runner-client');
    const { trustedExtract } = await import('../../server/extraction-worker-client');
    vi.mocked(trustedExtract).mockResolvedValueOnce({
      ok: true,
      data: {
        ok: true,
        extractionData: { title: 'T', brand: 'B', description: 'D', primaryImage: null, additionalImages: [], price: null, fieldProvenance: {} },
        warnings: [],
      } as any,
    });
    const profile: any = {
      id: 'p1', domain: 'example.com', titleSelector: 'h1', titleOptionalSelectors: [], priceSelector: null, descriptionSelector: null, brandSelector: null, imagesSelector: null, sitemapProductUrlPattern: null, shopifyJSONPath: false, customSelectors: {}, variantSelectionStrategy: null, customSelectorMetadata: {}, runtime: 'static', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
    await runProfileExtraction({
      sourceUrl: 'https://example.com/products/betterbone?variant=1',
      profile,
      expected: { name: 'BetterBone Small' },
      variantSelection: { resolutionId: 'res-1', identityMatrixHash: 'a'.repeat(64), variantKey: 'k1' },
    });
    const calls: any = vi.mocked(trustedExtract).mock.calls;
    const call: any = calls[calls.length-1][0];
    expect(call.variantSelection).toBeDefined();
    expect(call.variantSelection.variantKey).toBe('k1');
  });

  it('preserves structured failureCode from worker', async () => {
    const { runProfileExtraction } = await import('../../onboarding/profile-runner-client');
    const { trustedExtract } = await import('../../server/extraction-worker-client');
    vi.mocked(trustedExtract).mockResolvedValueOnce({
      ok: true,
      data: { ok: false, warnings: ['x'], failureCode: 'variant_selection_required', matrixDecision: { status: 'ambiguous' } } as any,
    });
    const profile: any = {
      id: 'p1', domain: 'example.com', titleSelector: 'h1', titleOptionalSelectors: [], priceSelector: null, descriptionSelector: null, brandSelector: null, imagesSelector: null, sitemapProductUrlPattern: null, shopifyJSONPath: false, customSelectors: {}, variantSelectionStrategy: null, customSelectorMetadata: {}, runtime: 'static', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
    const res: any = await runProfileExtraction({
      sourceUrl: 'https://example.com/products/betterbone',
      profile,
      expected: { name: 'BetterBone' },
    });
    expect(res.ok).toBe(false);
    expect(res.failureCode).toBe('variant_selection_required');
  });
});
