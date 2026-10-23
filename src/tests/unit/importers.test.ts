import { describe, it, expect } from 'vitest';
import { fetchOpenPetFoodFactsByGtin } from '../../crawler/importers/open-pet-food-facts.js';
import { fetchOpenIcecatByGtin } from '../../crawler/importers/icecat.js';

describe('Open Data Importers ($0 Cost Barcode Lookup)', () => {
  describe('Open Pet Food Facts Importer', () => {
    it('parses Open Pet Food Facts API response into ScrapedProductEvidence', async () => {
      const mockFetch = async () => {
        return {
          ok: true,
          json: async () => ({
            status: 1,
            status_verbose: 'product found',
            product: {
              code: '0070158005028',
              product_name: 'Zignature Lamb Formula Grain-Free Dry Dog Food',
              brands: 'Zignature',
              categories_hierarchy: ['en:pet-supplies', 'en:dog-supplies', 'en:dog-food', 'en:dry-dog-food'],
              ingredients_text: 'Lamb, Lamb Meal, Peas, Chickpeas, Pea Flour...',
              serving_size: '1 cup',
              quantity: '4 lb',
              image_url: 'https://images.openpetfoodfacts.org/1.jpg',
            },
          }),
        } as Response;
      };

      const evidence = await fetchOpenPetFoodFactsByGtin('0070158005028', mockFetch as unknown as typeof fetch);

      expect(evidence).not.toBeNull();
      expect(evidence?.title).toBe('Zignature Lamb Formula Grain-Free Dry Dog Food');
      expect(evidence?.brand).toBe('Zignature');
      expect(evidence?.gtin).toBe('0070158005028');
      expect(evidence?.rawBreadcrumb).toEqual(['pet supplies', 'dog supplies', 'dog food', 'dry dog food']);
      expect(evidence?.specifications?.['Ingredients']).toContain('Lamb');
      expect(evidence?.specifications?.['Package Weight / Size']).toBe('4 lb');
      expect(evidence?.images).toEqual(['https://images.openpetfoodfacts.org/1.jpg']);
    });

    it('returns null for missing or invalid GTIN', async () => {
      const mockFetch = async () => {
        return {
          ok: true,
          json: async () => ({ status: 0, status_verbose: 'product not found' }),
        } as Response;
      };

      const evidence = await fetchOpenPetFoodFactsByGtin('9999999999999', mockFetch as unknown as typeof fetch);
      expect(evidence).toBeNull();
    });
  });

  describe('Open Icecat Importer', () => {
    it('parses Open Icecat response into ScrapedProductEvidence', async () => {
      const mockFetch = async () => {
        return {
          ok: true,
          json: async () => ({
            data: {
              GeneralInfo: {
                Title: 'Purina Dog Chow Complete Adult Dry Dog Food',
                Brand: 'Purina',
                Category: { Name: { Value: 'Dog Food' } },
                Description: { LongDesc: 'Complete nutrition for adult dogs.' },
              },
              FeaturesGroups: [
                {
                  Features: [
                    { Feature: { Name: { Value: 'Life Stage' } }, Value: 'Adult' },
                    { Feature: { Name: { Value: 'Flavour' } }, Value: 'Chicken' },
                    { Feature: { Name: { Value: 'Price' } }, Value: '$19.99' },
                    { Feature: { Name: { Value: 'MAP' } }, Value: '$17.99' },
                  ],
                },
              ],
              Image: { HighPic: 'https://images.icecat.biz/1.jpg' },
            },
          }),
        } as Response;
      };

      const evidence = await fetchOpenIcecatByGtin('0073259000018', undefined, mockFetch as unknown as typeof fetch);

      expect(evidence).not.toBeNull();
      expect(evidence?.title).toBe('Purina Dog Chow Complete Adult Dry Dog Food');
      expect(evidence?.brand).toBe('Purina');
      expect(evidence?.gtin).toBe('0073259000018');
      expect(evidence?.rawBreadcrumb).toEqual(['Dog Food']);
      expect(evidence?.specifications).toEqual({
        'Life Stage': 'Adult',
        Flavour: 'Chicken',
      });
      expect(evidence?.description).toBe('Complete nutrition for adult dogs.');
    });
  });
});
