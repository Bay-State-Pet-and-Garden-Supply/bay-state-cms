import { describe, expect, it } from 'vitest';
import { extractProductJsonFromHtml } from '../../onboarding/shopify-json';

describe('Shopify page data price redaction', () => {
  it('keeps variant matching data but removes price fields recursively', () => {
    const thirdPartyProduct = {
      id: 42,
      title: 'Acme Product',
      price: '19.99',
      variants: [{
        id: 7,
        sku: 'ACME-7',
        price: '19.99',
        compare_at_price: '29.99',
        cost: '8.50',
        available: true,
        offers: { price: '19.99', availability: 'InStock' },
      }],
    };
    const html = `<script>window.productJSON = ${JSON.stringify(thirdPartyProduct)};</script>`;

    const product = extractProductJsonFromHtml(html);

    expect(product).toMatchObject({
      id: 42,
      title: 'Acme Product',
      variants: [{ id: 7, sku: 'ACME-7', available: true, offers: { availability: 'InStock' } }],
    });
    expect(JSON.stringify(product)).not.toContain('19.99');
    expect(JSON.stringify(product)).not.toContain('29.99');
  });
});
