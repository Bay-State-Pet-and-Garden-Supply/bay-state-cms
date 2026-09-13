import { describe, it, expect } from 'vitest';
import { selectHybridFields } from '../../onboarding/profile-audit/hybrid-field-selector';

describe('profile audit hybrid field selector', () => {
  const url = 'https://example.com/products/puppy-shampoo';
  const html = '<html><body><h1>Puppy Shampoo</h1></body></html>';

  it('surfaces conflict with provenance when selector and JSON-LD disagree', () => {
    const raw: any = {
      custom: {
        title: 'Selector Puppy Shampoo 16oz',
        brand: 'Earthbath',
      },
      jsonLd: {
        name: 'JSON-LD Gentle Puppy Shampoo',
        brand: { name: 'Earthbath' },
      },
      metaTags: {},
      microdata: {},
      htmlHeuristics: {},
      images: [],
    };

    const result = selectHybridFields({
      raw,
      url,
      html,
    });

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].field).toBe('title');
    expect(result.conflicts[0].selectorValue).toBe('Selector Puppy Shampoo 16oz');
    expect(result.conflicts[0].structuredValue).toBe('JSON-LD Gentle Puppy Shampoo');
    expect(result.conflicts[0].resolution).toBeTruthy();
    expect(result.data.title).toBeTruthy();
    expect(result.fieldProvenance.title).toBeTruthy();
  });

  it('produces no conflict when values agree or only one source exists', () => {
    const raw: any = {
      custom: {
        title: 'Puppy Shampoo',
      },
      jsonLd: {
        name: 'Puppy Shampoo',
        description: 'Soothing organic shampoo',
      },
      metaTags: {},
      microdata: {},
      htmlHeuristics: {},
      images: [],
    };

    const result = selectHybridFields({
      raw,
      url,
      html,
    });

    expect(result.conflicts).toHaveLength(0);
    expect(result.data.title).toBe('Puppy Shampoo');
    expect(result.data.description).toBe('Soothing organic shampoo');
    expect(result.fieldProvenance.description).toBe('json-ld');
  });

  it('resolves variant identity first and attaches variant decision', () => {
    const fakeMatrix: any = {
      platform: 'shopify',
      warnings: [],
      candidates: [
        {
          variantKey: 'var-16oz',
          title: 'Puppy Shampoo 16oz',
          sku: 'SKU-16',
          price: '14.99',
          available: true,
          identifiers: [{ kind: 'sku', rawValue: 'SKU-16', normalizedValue: 'sku-16' }],
          options: [{ name: 'Size', value: '16oz' }],
          images: [{ url: 'https://example.com/img-16.jpg' }],
        },
        {
          variantKey: 'var-32oz',
          title: 'Puppy Shampoo 32oz',
          sku: 'SKU-32',
          price: '24.99',
          available: true,
          identifiers: [{ kind: 'sku', rawValue: 'SKU-32', normalizedValue: 'sku-32' }],
          options: [{ name: 'Size', value: '32oz' }],
          images: [{ url: 'https://example.com/img-32.jpg' }],
        },
      ],
    };

    const raw: any = {
      custom: { title: 'Puppy Shampoo' },
      jsonLd: { name: 'Puppy Shampoo' },
      metaTags: {},
      microdata: {},
      htmlHeuristics: {},
      images: ['https://example.com/img-16.jpg', 'https://example.com/img-32.jpg'],
    };

    const result = selectHybridFields({
      raw,
      url,
      html,
      variantMatrix: fakeMatrix,
      expected: { name: 'Puppy Shampoo 16oz', sku: 'SKU-16' },
    });

    expect(result.variantDecision).toBeTruthy();
    expect(result.variantDecision?.selectedVariantKey).toBe('var-16oz');
    expect(result.data.sku).toBe('SKU-16');
    expect(result.data.price).toBe('14.99');
    expect(result.admittedImages).toContain('https://example.com/img-16.jpg');
    expect(result.admittedImages).not.toContain('https://example.com/img-32.jpg');
  });
});
