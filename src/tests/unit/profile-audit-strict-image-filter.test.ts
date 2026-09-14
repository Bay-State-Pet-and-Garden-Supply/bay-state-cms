import { describe, it, expect } from 'vitest';
import { applyStrictImageFilter, isRoleRejectedImage } from '../../onboarding/profile-audit/strict-image-filter';

describe('profile audit strict image filter', () => {
  const baseUrl = 'https://earthbath.com/products/hot-spot-relief-spray';

  it('filters out non-usable, SVG, social, and payment icons with exact reasons', () => {
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
    expect(result.rejectionReasons['https://earthbath.com/assets/facebook-icon.svg']).toBe('not_usable'); // .svg is filtered by isUsableImageSource
    expect(result.rejectedImages).toContain('https://earthbath.com/assets/visa-logo.png');
    expect(result.rejectionReasons['https://earthbath.com/assets/visa-logo.png']).toBe('role_rejected');
    expect(result.rejectedImages).toContain('https://earthbath.com/assets/free-shipping-badge.png');
    expect(result.rejectionReasons['https://earthbath.com/assets/free-shipping-badge.png']).toBe('role_rejected');

    expect(result.primaryImage).toBe('https://earthbath.com/cdn/shop/files/PT3S-HotSpot-Spray-front_1800x.png?width=1200');
  });

  it('rejects color swatches, rating stars, and marketing banners', () => {
    const rawImages = [
      'https://example.com/images/products/hero.jpg',
      'https://example.com/images/swatches/blue-swatch.png',
      'https://example.com/assets/rating/star-rating-5.svg',
      'https://example.com/assets/promo/promobar-summer.jpg',
      'https://example.com/assets/pay/paypal-badge.png',
      'https://example.com/assets/applepay-logo.png',
    ];

    const result = applyStrictImageFilter({
      images: rawImages,
      baseUrl: 'https://example.com/products/test',
    });

    expect(result.admittedImages).toHaveLength(1);
    expect(result.admittedImages[0]).toBe('https://example.com/images/products/hero.jpg');
    expect(result.rejectedImages).toContain('https://example.com/images/swatches/blue-swatch.png');
    expect(result.rejectionReasons['https://example.com/images/swatches/blue-swatch.png']).toBe('role_rejected');
  });

  it('deduplicates different resolution sizes and records dropped resolutions with resolution_duplicate', () => {
    const rawImages = [
      'https://earthbath.com/cdn/shop/files/PT3S-HotSpot-Spray-front_400x.png?v=1780415946',
      'https://earthbath.com/cdn/shop/files/PT3S-HotSpot-Spray-front_800x.png?v=1780415946',
      'https://earthbath.com/cdn/shop/files/PT3S-HotSpot-Spray-front_1800x.png?v=1780415946',
    ];

    const result = applyStrictImageFilter({
      images: rawImages,
      baseUrl,
    });

    // Only 1 canonical image admitted (normalized to width=1200)
    expect(result.admittedImages).toHaveLength(1);
    expect(result.primaryImage).toBe(result.admittedImages[0]);

    // Dropped duplicates recorded with resolution_duplicate
    expect(result.rejectedImages.length).toBeGreaterThanOrEqual(2);
    for (const rej of result.rejectedImages) {
      expect(result.rejectionReasons[rej]).toBe('resolution_duplicate');
    }
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

  it('admits proven shared-product images across all candidates even if not in otherVariant set', () => {
    const fakeMatrix: any = {
      candidates: [
        {
          variantKey: 'var-1',
          images: [
            { url: 'https://example.com/cdn/p/var-1-hero.jpg' },
            { url: 'https://example.com/cdn/p/nutrition-label.jpg' },
          ],
        },
        {
          variantKey: 'var-2',
          images: [
            { url: 'https://example.com/cdn/p/var-2-hero.jpg' },
            { url: 'https://example.com/cdn/p/nutrition-label.jpg' },
          ],
        },
      ],
    };

    const result = applyStrictImageFilter({
      images: [
        'https://example.com/cdn/p/var-1-hero.jpg',
        'https://example.com/cdn/p/var-2-hero.jpg',
        'https://example.com/cdn/p/nutrition-label.jpg',
      ],
      baseUrl: 'https://example.com/products/kibble',
      variantMatrix: fakeMatrix,
      selectedVariantKey: 'var-1',
    });

    expect(result.admittedImages).toContain('https://example.com/cdn/p/var-1-hero.jpg');
    expect(result.admittedImages).toContain('https://example.com/cdn/p/nutrition-label.jpg');
    expect(result.admittedImages).not.toContain('https://example.com/cdn/p/var-2-hero.jpg');
    expect(result.rejectedImages).toContain('https://example.com/cdn/p/var-2-hero.jpg');
    expect(result.rejectionReasons['https://example.com/cdn/p/var-2-hero.jpg']).toBe('other_variant');
  });

  it('respects role: primary and customPrimaryImage priority for primary flagging', () => {
    const rawImages = [
      { url: 'https://example.com/cdn/products/gallery-1.jpg', role: 'gallery' as const },
      { url: 'https://example.com/cdn/products/hero-primary.jpg', role: 'primary' as const },
      { url: 'https://example.com/cdn/products/gallery-2.jpg', role: 'gallery' as const },
    ];

    const result = applyStrictImageFilter({
      images: rawImages,
      baseUrl: 'https://example.com/products/widget',
    });

    expect(result.primaryImage).toBe('https://example.com/cdn/products/hero-primary.jpg');
    expect(result.admittedImages[0]).toBe('https://example.com/cdn/products/hero-primary.jpg');
  });

  it('enforces safety caps on maximum gallery size and records cap_exceeded', () => {
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

  it('isRoleRejectedImage detects all forbidden pattern variations correctly', () => {
    expect(isRoleRejectedImage('https://cdn.example.com/icons/search.png')).toBe(true);
    expect(isRoleRejectedImage('https://cdn.example.com/favicon.ico')).toBe(true);
    expect(isRoleRejectedImage('https://cdn.example.com/img/cert-seal.png')).toBe(true);
    expect(isRoleRejectedImage('https://cdn.example.com/logos/brand-logo.png')).toBe(true);
    expect(isRoleRejectedImage('https://cdn.example.com/social/instagram.png')).toBe(true);
    expect(isRoleRejectedImage('https://cdn.example.com/cards/mastercard.png')).toBe(true);
    expect(isRoleRejectedImage('https://cdn.example.com/swatches/red-swatch.jpg')).toBe(true);
    expect(isRoleRejectedImage('https://cdn.example.com/products/clean-product-shot.jpg')).toBe(false);
  });
});
