import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { parseChewyProductHtml, extractChewyCatalogLinks } from '../../crawler/sites/chewy.js';
import { parseTractorSupplyProductHtml } from '../../crawler/sites/tractor-supply.js';
import { parseBurpeeProductHtml } from '../../crawler/sites/burpee.js';
import { parseAceHardwareProductHtml } from '../../crawler/sites/ace-hardware.js';
import { DatasetExporter } from '../../crawler/dataset-exporter.js';
import { ScrapedProductEvidenceSchema } from '../../crawler/corpus-schema.js';

describe('Training Corpus Crawler Parsers', () => {
  describe('Chewy HTML Parser', () => {
    it('parses title, brand, breadcrumbs, specifications and JSON-LD from Chewy HTML', () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <script type="application/ld+json">
              {
                "@type": "Product",
                "gtin13": "0123456789012",
                "mpn": "CHEWY-123",
                "description": "Premium adult dry kibble dog food."
              }
            </script>
          </head>
          <body>
            <h1 data-testid="product-title">Blue Buffalo Life Protection Formula Adult Chicken & Brown Rice Recipe Dry Dog Food</h1>
            <div data-testid="brand-name">Blue Buffalo</div>
            <nav class="breadcrumbs">
              <ul>
                <li>Home</li>
                <li>></li>
                <li>Dog</li>
                <li>Food</li>
                <li>Dry Food</li>
              </ul>
            </nav>
            <table class="specs-table">
              <tr><th>Food Form</th><td>Dry Food</td></tr>
              <tr><th>Lifestage</th><td>Adult</td></tr>
              <tr><th>Price</th><td>$19.99</td></tr>
            </table>
          </body>
        </html>
      `;

      const $ = cheerio.load(html);
      const url = 'https://www.chewy.com/dp/12345';
      const evidence = parseChewyProductHtml(url, $);

      expect(evidence).not.toBeNull();
      expect(evidence?.title).toBe('Blue Buffalo Life Protection Formula Adult Chicken & Brown Rice Recipe Dry Dog Food');
      expect(evidence?.brand).toBe('Blue Buffalo');
      expect(evidence?.gtin).toBe('0123456789012');
      expect(evidence?.rawBreadcrumb).toEqual(['Dog', 'Food', 'Dry Food']);
      expect(evidence?.specifications).toEqual({
        'Food Form': 'Dry Food',
        Lifestage: 'Adult',
      });
      expect(evidence?.description).toBe('Premium adult dry kibble dog food.');

      // Validate against schema
      const validated = ScrapedProductEvidenceSchema.safeParse(evidence);
      expect(validated.success).toBe(true);
    });

    it('extracts catalog links cleanly', () => {
      const html = `
        <a href="/dp/9999">Product Link</a>
        <a href="/b/blue-buffalo">Brand Link</a>
        <a href="https://other.com/foo">External Link</a>
      `;
      const $ = cheerio.load(html);
      const links = extractChewyCatalogLinks($, 'https://www.chewy.com');
      expect(links).toContain('https://www.chewy.com/dp/9999');
      expect(links).toContain('https://www.chewy.com/b/blue-buffalo');
      expect(links.some((l) => l.includes('other.com'))).toBe(false);
    });
  });

  describe('Tractor Supply Parser', () => {
    it('parses Tractor Supply HTML fixtures', () => {
      const html = `
        <html>
          <body>
            <h1 data-id="product-name">Purina Layena Crumbles Poultry Feed, 50 lb.</h1>
            <div data-id="product-brand">Purina</div>
            <ul class="breadcrumb">
              <li>Home</li>
              <li>Poultry Supplies</li>
              <li>Chicken Feed</li>
            </ul>
            <div class="specifications-table">
              <table>
                <tr><td>Animal Type</td><td>Chicken</td></tr>
                <tr><td>Weight</td><td>50 lb</td></tr>
                <tr><td>Price</td><td>$19.99</td></tr>
              </table>
            </div>
          </body>
        </html>
      `;
      const $ = cheerio.load(html);
      const url = 'https://www.tractorsupply.com/tsc/product/purina-layena';
      const evidence = parseTractorSupplyProductHtml(url, $);

      expect(evidence).not.toBeNull();
      expect(evidence?.title).toBe('Purina Layena Crumbles Poultry Feed, 50 lb.');
      expect(evidence?.brand).toBe('Purina');
      expect(evidence?.rawBreadcrumb).toEqual(['Poultry Supplies', 'Chicken Feed']);
      expect(evidence?.specifications).toEqual({
        'Animal Type': 'Chicken',
        Weight: '50 lb',
      });
    });
  });

  describe('Burpee Lawn & Garden Parser', () => {
    it('parses Burpee plant/seed product page', () => {
      const html = `
        <html>
          <body>
            <h1 class="product-name">Tomato, Brandywine Pink</h1>
            <ol class="breadcrumb">
              <li>Home</li>
              <li>Vegetables</li>
              <li>Tomatoes</li>
            </ol>
            <table class="attributes">
              <tr><th>Sunlight</th><td>Full Sun</td></tr>
              <tr><th>Plant Habit</th><td>Indeterminate</td></tr>
              <tr><th>Sale Price</th><td>$17.99</td></tr>
            </table>
          </body>
        </html>
      `;
      const $ = cheerio.load(html);
      const url = 'https://www.burpee.com/tomato-brandywine.html';
      const evidence = parseBurpeeProductHtml(url, $);

      expect(evidence).not.toBeNull();
      expect(evidence?.title).toBe('Tomato, Brandywine Pink');
      expect(evidence?.brand).toBe('Burpee');
      expect(evidence?.rawBreadcrumb).toEqual(['Vegetables', 'Tomatoes']);
      expect(evidence?.specifications).toEqual({
        Sunlight: 'Full Sun',
        'Plant Habit': 'Indeterminate',
      });
    });
  });

  describe('Ace Hardware Parser', () => {
    it('parses Ace Hardware product page', () => {
      const html = `
        <html>
          <body>
            <h1 class="product-title">Scotts Turf Builder Weed and Feed Lawn Fertilizer 14.29 lb</h1>
            <div data-test="product-brand">Scotts</div>
            <ul class="breadcrumbs">
              <li>Home</li>
              <li>Lawn and Garden</li>
              <li>Lawn Care</li>
              <li>Fertilizer</li>
            </ul>
            <table class="specs">
              <tr><th>Price</th><td>$19.99</td></tr>
              <tr><th>Weight</th><td>14 lb</td></tr>
            </table>
          </body>
        </html>
      `;
      const $ = cheerio.load(html);
      const url = 'https://www.acehardware.com/departments/outdoor-living/lawn-and-garden/scotts-123/p/1234567';
      const evidence = parseAceHardwareProductHtml(url, $);

      expect(evidence).not.toBeNull();
      expect(evidence?.title).toBe('Scotts Turf Builder Weed and Feed Lawn Fertilizer 14.29 lb');
      expect(evidence?.brand).toBe('Scotts');
      expect(evidence?.rawBreadcrumb).toEqual(['Lawn and Garden', 'Lawn Care', 'Fertilizer']);
      expect(evidence?.specifications).toEqual({ Weight: '14 lb' });
    });
  });

  describe('Dataset Exporter Metrics', () => {
    it('calculates coverage statistics correctly', () => {
      const exporter = new DatasetExporter();
      const metrics = exporter.computeMetrics([
        {
          id: '1',
          retailer: 'chewy.com',
          sourceUrl: 'https://chewy.com/dp/1',
          scrapedAt: new Date().toISOString(),
          title: 'Product 1',
          gtin: '123456789012',
          brand: 'Brand A',
          rawBreadcrumb: ['Dog', 'Food'],
          specifications: { Form: 'Dry' },
          images: [],
        },
        {
          id: '2',
          retailer: 'chewy.com',
          sourceUrl: 'https://chewy.com/dp/2',
          scrapedAt: new Date().toISOString(),
          title: 'Product 2',
          rawBreadcrumb: [],
          specifications: {},
          images: [],
        },
      ]);

      expect(metrics.totalItems).toBe(2);
      expect(metrics.upcCoverage).toBe(0.5);
      expect(metrics.brandCoverage).toBe(0.5);
      expect(metrics.breadcrumbCoverage).toBe(0.5);
      expect(metrics.specsCoverage).toBe(0.5);
    });
  });
});
