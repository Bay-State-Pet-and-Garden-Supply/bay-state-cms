import { describe, it, expect, vi } from 'vitest';
import { BrightDataScraperClient } from '../../crawler/importers/brightdata-scraper.js';

describe('BrightDataScraperClient (Cloud Scraper API)', () => {
  it('triggers a scraper job and returns a snapshot_id', async () => {
    const mockApiKey = 'test_api_key_123';
    const client = new BrightDataScraperClient(mockApiKey);

    const globalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      preconnect: async () => undefined,
      json: async () => ({ snapshot_id: 's_m4x7enmven8djfqak' }),
    }) as unknown as typeof fetch;

    try {
      const snapshotId = await client.triggerScraper('gd_chewy_dataset', [
        'https://www.chewy.com/dp/123456',
      ]);

      expect(snapshotId).toBe('s_m4x7enmven8djfqak');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.brightdata.com/datasets/v3/trigger?dataset_id=gd_chewy_dataset',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test_api_key_123',
          }),
        })
      );
    } finally {
      globalThis.fetch = globalFetch;
    }
  });

  it('normalizes raw Bright Data Chewy items into ScrapedProductEvidence', () => {
    const client = new BrightDataScraperClient('dummy');
    const evidence = client.normalizeChewyItem({
      id: 'chewy-101',
      url: 'https://www.chewy.com/dp/123456',
      title: 'Blue Buffalo Life Protection Formula Adult Chicken & Brown Rice Recipe',
      brand: 'Blue Buffalo',
      gtin: '0840243105625',
      categories: ['Dog', 'Dog Food', 'Dry Kibble'],
      description: 'High-quality chicken meal and whole grains.',
      specifications: {
        'Lifestage': 'Adult',
        'Breed Size': 'All Breeds',
        'Sale Price': '$17.99',
      },
      images: ['https://image.chewy.com/1.jpg'],
    });

    expect(evidence).not.toBeNull();
    expect(evidence?.title).toBe('Blue Buffalo Life Protection Formula Adult Chicken & Brown Rice Recipe');
    expect(evidence?.brand).toBe('Blue Buffalo');
    expect(evidence?.retailer).toBe('chewy.com');
    expect(evidence?.rawBreadcrumb).toEqual(['Dog', 'Dog Food', 'Dry Kibble']);
    expect(evidence?.specifications?.['Lifestage']).toBe('Adult');
    expect(evidence?.specifications).toEqual({
      Lifestage: 'Adult',
      'Breed Size': 'All Breeds',
    });
  });
});
