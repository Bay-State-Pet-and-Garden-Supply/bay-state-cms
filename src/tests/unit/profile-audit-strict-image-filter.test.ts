import { describe, it, expect } from 'vitest';
import { applyStrictImageFilter } from '../../onboarding/profile-audit/strict-image-filter';

describe('profile audit strict image filter', () => {
  const baseUrl = 'https://earthbath.com/products/hot-spot-relief-spray';

  it('filters out non-usable, SVG, social, and payment icons', () => {
    const rawImages = [
      'https://earthbath.com/cdn/shop/files/PT3S-HotSpot-Spray-front_1800x.png',
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'https://earthbath.com/assets/facebook-icon.svg',
      'https://earthbath.com/assets/visa-logo.png',
      'https://earthbath.com/cdn/shop/files/PT3S-HotSpot-Spray-back_1800x.png',
      'https://earthbath.com/assets/free-shipping-badge.png',
    ];

    const result = applyStrictImageFilter({
      images: rawImages,
      baseUrl,
    });

    expect(result.admittedImages).toContain('https://earthbath.com/cdn/shop/files/PT3S-HotSpot-Spray-front_1800x.png?width=1200');
    expect(result.admittedImages).toContain('https://earthbath.com/cdn/shop/files/PT3S-HotSpot-Spray-back_1800x.png?width=1200');
    expect(result.admittedImages).toHaveLength(2);

    expect(result.rejectedImages).toContain('https://earthbath.com/assets/facebook-icon.svg');
    expect(result.rejectedImages).toContain('https://earthbath.com/assets/visa-logo.png');
    expect(result.primaryImage).toBe('https://earthbath.com/cdn/shop/files/PT3S-HotSpot-Spray-front_1800x.png?width=1200');
  });

  it('deduplicates different resolution sizes of the same image to a single canonical image', () => {
    const rawImages = [
      'https://earthbath.com/cdn/shop/files/PT3S-HotSpot-Spray-front_400x.png?v=1780415946',
      'https://earthbath.com/cdn/shop/files/PT3S-HotSpot-Spray-front_800x.png?v=1780415946',
      'https://earthbath.com/cdn/shop/files/PT3S-HotSpot-Spray-front_1800x.png?v=1780415946',
    ];

    const result = applyStrictImageFilter({
      images: rawImages,
      baseUrl,
    });

    // Only 1 canonical image admitted
    expect(result.admittedImages).toHaveLength(1);
    expect(result.primaryImage).toBe(result.admittedImages[0]);
  });

  it('admits selected-variant images and excludes other-variant images when matrix is present', () => {
    const rawImages = [
      'https://example.com/cdn/products/widget-blue-front.jpg',
      'https://example.com/cdn/products/widget-red-front.jpg',
      'https://example.com/cdn/products/widget-shared-dimensions.jpg',
    ];

    const fakeMatrix: any = {
      candidates: [
        {
          variantKey: 'blue',
          images: [{ url: 'https://example.com/cdn/products/widget-blue-front.jpg', alt: 'Blue Widget' }],
        },
        {
          variantKey: 'red',
          images: [{ url: 'https://example.com/cdn/products/widget-red-front.jpg', alt: 'Red Widget' }],
        },
      ],
    };

    const result = applyStrictImageFilter({
      images: rawImages,
      baseUrl: 'https://example.com/products/widget',
      variantMatrix: fakeMatrix,
      selectedVariantKey: 'blue',
    });

    expect(result.admittedImages).toContain('https://example.com/cdn/products/widget-blue-front.jpg');
    expect(result.admittedImages).toContain('https://example.com/cdn/products/widget-shared-dimensions.jpg');
    expect(result.admittedImages).not.toContain('https://example.com/cdn/products/widget-red-front.jpg');
    expect(result.rejectedImages).toContain('https://example.com/cdn/products/widget-red-front.jpg');
    expect(result.rejectionReasons['https://example.com/cdn/products/widget-red-front.jpg']).toBe('other_variant');
  });

  it('enforces safety caps on maximum gallery size', () => {
    const manyImages = Array.from({ length: 25 }, (_, i) => `https://example.com/cdn/products/photo-${i}.jpg`);

    const result = applyStrictImageFilter({
      images: manyImages,
      baseUrl: 'https://example.com/products/widget',
      maxImages: 10,
    });

    expect(result.admittedImages).toHaveLength(10);
    expect(result.rejectedImages).toHaveLength(15);
    expect(result.rejectionReasons['https://example.com/cdn/products/photo-10.jpg']).toBe('cap_exceeded');
  });
});
