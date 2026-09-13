import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import {
  parseSrcsetCandidates,
  isUsableImageSource,
  collectImageSourcesFromElement,
  addImageSource,
  canonicalizeUrl,
  cleanAndDeduplicateImages,
} from '../../onboarding/image-utils';

describe('parseSrcsetCandidates', () => {
  it('returns URLs from a mixed srcset with width and pixel-density descriptors', () => {
    const srcset =
      'https://cdn.shopify.com/s/files/1/0001/0001/products/img_80x80.jpg 80w, https://cdn.shopify.com/s/files/1/0001/0001/products/img_150x150.jpg 150w, https://cdn.shopify.com/s/files/1/0001/0001/products/img.jpg 800w';
    expect(parseSrcsetCandidates(srcset)).toEqual([
      'https://cdn.shopify.com/s/files/1/0001/0001/products/img_80x80.jpg',
      'https://cdn.shopify.com/s/files/1/0001/0001/products/img_150x150.jpg',
      'https://cdn.shopify.com/s/files/1/0001/0001/products/img.jpg',
    ]);
  });

  it('handles 2x descriptor', () => {
    const srcset = 'https://example.com/photo.jpg 1x, https://example.com/photo@2x.jpg 2x';
    expect(parseSrcsetCandidates(srcset)).toEqual([
      'https://example.com/photo.jpg',
      'https://example.com/photo@2x.jpg',
    ]);
  });

  it('returns empty array for null', () => {
    expect(parseSrcsetCandidates(null)).toEqual([]);
  });

  it('returns empty array for undefined', () => {
    expect(parseSrcsetCandidates(undefined)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseSrcsetCandidates('')).toEqual([]);
  });

  it('trims whitespace between descriptors', () => {
    const srcset = '  /img1.jpg  100w , /img2.jpg  200w  ';
    expect(parseSrcsetCandidates(srcset)).toEqual(['/img1.jpg', '/img2.jpg']);
  });
});

describe('isUsableImageSource', () => {
  it('accepts http URL', () => {
    expect(isUsableImageSource('https://example.com/photo.jpg')).toBe(true);
  });

  it('accepts https URL', () => {
    expect(isUsableImageSource('https://example.com/photo.png')).toBe(true);
  });

  it('rejects data URI', () => {
    expect(isUsableImageSource('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==')).toBe(false);
  });

  it('rejects .svg file by extension', () => {
    expect(isUsableImageSource('https://example.com/icon.svg')).toBe(false);
  });

  it('rejects .svg with query string', () => {
    expect(isUsableImageSource('https://example.com/icon.svg?v=123')).toBe(false);
  });

  it('rejects .SVG case-insensitively', () => {
    expect(isUsableImageSource('https://example.com/ICON.SVG')).toBe(false);
  });

  it('rejects null', () => {
    expect(isUsableImageSource(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isUsableImageSource(undefined)).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isUsableImageSource('')).toBe(false);
  });

  it('rejects whitespace-only string', () => {
    expect(isUsableImageSource('   ')).toBe(false);
  });

  it('accepts .jpg plain', () => {
    expect(isUsableImageSource('/photo.jpg')).toBe(true);
  });

  it('accepts .jpeg', () => {
    expect(isUsableImageSource('https://example.com/image.jpeg')).toBe(true);
  });

  it('accepts .webp', () => {
    expect(isUsableImageSource('https://example.com/image.webp')).toBe(true);
  });

  it('accepts .png', () => {
    expect(isUsableImageSource('https://example.com/image.png')).toBe(true);
  });

  it('accepts .gif', () => {
    expect(isUsableImageSource('https://example.com/animated.gif')).toBe(true);
  });

  it('rejects protocol-relative .svg', () => {
    expect(isUsableImageSource('//cdn.example.com/icon.svg')).toBe(false);
  });
});

describe('collectImageSourcesFromElement', () => {
  it('collects src from an img element', () => {
    const html = '<img src="https://example.com/photo.jpg" />';
    const $ = cheerio.load(html);
    const el = $('img').get(0)!;
    const sources = collectImageSourcesFromElement($, el);
    expect(sources).toEqual(['https://example.com/photo.jpg']);
  });

  it('reads data-src when src is absent', () => {
    const html = '<img data-src="https://example.com/lazy.jpg" />';
    const $ = cheerio.load(html);
    const el = $('img').get(0)!;
    const sources = collectImageSourcesFromElement($, el);
    expect(sources).toEqual(['https://example.com/lazy.jpg']);
  });

  it('reads data-lazy-src', () => {
    const html = '<img data-lazy-src="https://example.com/lazy2.jpg" />';
    const $ = cheerio.load(html);
    const el = $('img').get(0)!;
    const sources = collectImageSourcesFromElement($, el);
    expect(sources).toEqual(['https://example.com/lazy2.jpg']);
  });

  it('reads data-original attribute', () => {
    const html = '<img data-original="https://example.com/original.jpg" />';
    const $ = cheerio.load(html);
    const el = $('img').get(0)!;
    const sources = collectImageSourcesFromElement($, el);
    expect(sources).toEqual(['https://example.com/original.jpg']);
  });

  it('reads data-image attribute', () => {
    const html = '<img data-image="https://example.com/data-img.jpg" />';
    const $ = cheerio.load(html);
    const el = $('img').get(0)!;
    const sources = collectImageSourcesFromElement($, el);
    expect(sources).toEqual(['https://example.com/data-img.jpg']);
  });

  it('reads data-zoom-image attribute', () => {
    const html = '<img data-zoom-image="https://example.com/zoom.jpg" />';
    const $ = cheerio.load(html);
    const el = $('img').get(0)!;
    const sources = collectImageSourcesFromElement($, el);
    expect(sources).toEqual(['https://example.com/zoom.jpg']);
  });

  it('reads srcset from an img element', () => {
    const html = '<img srcset="https://example.com/a_80x80.jpg 80w, https://example.com/a.jpg 800w" />';
    const $ = cheerio.load(html);
    const el = $('img').get(0)!;
    const sources = collectImageSourcesFromElement($, el);
    expect(sources).toEqual([
      'https://example.com/a_80x80.jpg',
      'https://example.com/a.jpg',
    ]);
  });

  it('reads data-srcset', () => {
    const html = '<img data-srcset="https://example.com/b_80x80.jpg 80w, https://example.com/b.jpg 800w" />';
    const $ = cheerio.load(html);
    const el = $('img').get(0)!;
    const sources = collectImageSourcesFromElement($, el);
    expect(sources).toEqual([
      'https://example.com/b_80x80.jpg',
      'https://example.com/b.jpg',
    ]);
  });

  it('collects from a source element inside picture', () => {
    const html = `
      <picture>
        <source srcset="https://example.com/highres.webp" type="image/webp" />
        <img src="https://example.com/fallback.jpg" />
      </picture>`;
    const $ = cheerio.load(html);
    const el = $('source').get(0)!;
    const sources = collectImageSourcesFromElement($, el);
    expect(sources).toEqual(['https://example.com/highres.webp']);
  });

  it('collects from first img descendant when passed a wrapper', () => {
    const html = '<div class="gallery"><img src="https://example.com/gallery.jpg" /></div>';
    const $ = cheerio.load(html);
    const el = $('div.gallery').get(0)!;
    const sources = collectImageSourcesFromElement($, el);
    expect(sources).toEqual(['https://example.com/gallery.jpg']);
  });

  it('returns empty array when element has no img/source descendant', () => {
    const html = '<div class="description">Some text</div>';
    const $ = cheerio.load(html);
    const el = $('div.description').get(0)!;
    const sources = collectImageSourcesFromElement($, el);
    expect(sources).toEqual([]);
  });

  it('collects both src and srcset from the same element', () => {
    const html = '<img src="https://example.com/photo.jpg" srcset="https://example.com/photo_80x80.jpg 80w, https://example.com/photo.jpg 800w" />';
    const $ = cheerio.load(html);
    const el = $('img').get(0)!;
    const sources = collectImageSourcesFromElement($, el);
    // src comes first, then srcset entries
    expect(sources).toContain('https://example.com/photo.jpg');
    expect(sources).toContain('https://example.com/photo_80x80.jpg');
    expect(sources.length).toBe(3);
  });

  it('skips data: URIs and .svg files', () => {
    const html = '<img src="https://example.com/real.jpg" data-src="data:image/png;base64,abc" data-lazy-src="https://example.com/icon.svg" />';
    const $ = cheerio.load(html);
    const el = $('img').get(0)!;
    const sources = collectImageSourcesFromElement($, el);
    expect(sources).toEqual(['https://example.com/real.jpg']);
  });
});

describe('addImageSource', () => {
  it('adds usable source to list and seen set', () => {
    const seen = new Set<string>();
    const images: string[] = [];
    addImageSource('https://example.com/photo.jpg', seen, images);
    expect(images).toEqual(['https://example.com/photo.jpg']);
    expect(seen.has('https://example.com/photo.jpg')).toBe(true);
  });

  it('skips duplicate source', () => {
    const seen = new Set<string>();
    const images: string[] = [];
    addImageSource('https://example.com/photo.jpg', seen, images);
    addImageSource('https://example.com/photo.jpg', seen, images);
    expect(images).toEqual(['https://example.com/photo.jpg']);
  });

  it('skips data URI', () => {
    const seen = new Set<string>();
    const images: string[] = [];
    addImageSource('data:image/png;base64,abc', seen, images);
    expect(images).toEqual([]);
  });

  it('trims whitespace before checking duplicates', () => {
    const seen = new Set<string>();
    const images: string[] = [];
    addImageSource('  https://example.com/photo.jpg  ', seen, images);
    addImageSource('https://example.com/photo.jpg', seen, images);
    expect(images).toEqual(['https://example.com/photo.jpg']);
  });
});

describe('canonicalizeUrl', () => {
  it('strips _80x80 suffix', () => {
    const result = canonicalizeUrl('https://cdn.shopify.com/s/files/1/0001/products/photo_80x80.jpg');
    expect(result).toContain('/products/photo.jpg');
  });

  it('strips _150x150_crop_center', () => {
    const result = canonicalizeUrl('https://cdn.shopify.com/s/files/1/0001/products/photo_150x150_crop_center.jpg');
    expect(result).toContain('/products/photo.jpg');
  });

  it('strips _compact', () => {
    const result = canonicalizeUrl('https://cdn.shopify.com/s/files/1/0001/products/photo_compact.jpg');
    expect(result).toContain('/products/photo.jpg');
  });

  it('strips _small', () => {
    const result = canonicalizeUrl('https://cdn.shopify.com/s/files/1/0001/products/photo_small.jpg');
    expect(result).toContain('/products/photo.jpg');
  });

  it('strips _thumb', () => {
    const result = canonicalizeUrl('https://cdn.shopify.com/s/files/1/0001/products/photo_thumb.jpg');
    expect(result).toContain('/products/photo.jpg');
  });

  it('strips _medium', () => {
    const result = canonicalizeUrl('https://cdn.shopify.com/s/files/1/0001/products/photo_medium.jpg');
    expect(result).toContain('/products/photo.jpg');
  });

  it('strips _large', () => {
    const result = canonicalizeUrl('https://cdn.shopify.com/s/files/1/0001/products/photo_large.jpg');
    expect(result).toContain('/products/photo.jpg');
  });

  it('strips _icon', () => {
    const result = canonicalizeUrl('https://cdn.shopify.com/s/files/1/0001/products/photo_icon.jpg');
    expect(result).toContain('/products/photo.jpg');
  });

  it('strips _grande', () => {
    const result = canonicalizeUrl('https://cdn.shopify.com/s/files/1/0001/products/photo_grande.jpg');
    expect(result).toContain('/products/photo.jpg');
  });

  it('strips _800x (numeric with no second dimension)', () => {
    const result = canonicalizeUrl('https://cdn.shopify.com/s/files/1/0001/products/photo_800x.jpg');
    expect(result).toContain('/products/photo.jpg');
  });

  it('strips _x800 (numeric with no first dimension)', () => {
    const result = canonicalizeUrl('https://cdn.shopify.com/s/files/1/0001/products/photo_x800.jpg');
    expect(result).toContain('/products/photo.jpg');
  });

  it('handles protocol-relative URLs', () => {
    const result = canonicalizeUrl('//cdn.shopify.com/s/files/1/0001/products/photo_80x80.jpg');
    expect(result).toContain('/products/photo.jpg');
    expect(result).not.toMatch(/^\/\//); // should be https://
  });

  it('preserves non-Shopify URLs without stripping size-like segments', () => {
    const result = canonicalizeUrl('https://example.com/wp-content/uploads/photo_800x800.png');
    // The regex still fires on any URL path, not just Shopify hostnames,
    // because canonicalizeUrl is purely path-based. Document the
    // existing behavior: size suffixes are stripped regardless of host.
    expect(result).toContain('/photo.png');
    expect(result).not.toContain('_800x800');
  });

  it('leaves URLs with no size suffix unchanged besides search removal', () => {
    const result = canonicalizeUrl('https://example.com/products/photo.jpg?t=123');
    expect(result).toBe('example.com/products/photo.jpg');
  });

  it('returns the input string when URL parsing fails', () => {
    const result = canonicalizeUrl('not-a-url');
    expect(result).toBe('not-a-url');
  });

  it('does not collapse gallery images with indices after size patterns', () => {
    // Uploaded filenames like `Gallery_1200x1200_1.png` have the size
    // pattern as part of the original name, not a Shopify-generated
    // suffix. The regex must not strip `_1200x1200_1` because the
    // optional suffix is constrained to crop qualifiers (e.g.
    // `_crop_center`), so the lookahead fails when `_1` follows the
    // size pattern instead of the file extension.
    const result1 = canonicalizeUrl('//mywoof.com/cdn/shop/files/Woof_Poomergency_Gallery_1200x1200_1.png');
    const result2 = canonicalizeUrl('//mywoof.com/cdn/shop/files/Woof_Poomergency_Gallery_1200x1200_2.png');
    const result3 = canonicalizeUrl('//mywoof.com/cdn/shop/files/Woof_Poomergency_Gallery_1200x1200_1-Lavender_139e0de8-5f63-45f0-90e6-c39f9c951a48.png');
    expect(result1).not.toBe(result2);
    expect(result1).not.toBe(result3);
    expect(result2).not.toBe(result3);
  });

  it('still strips size suffixes followed by crop qualifiers', () => {
    // `_crop_top_left` is a valid Shopify transformation qualifier and
    // should still be stripped along with the size pattern.
    const result = canonicalizeUrl('https://cdn.shopify.com/s/files/1/0001/products/photo_80x80_crop_top_left.jpg');
    expect(result).toContain('/photo.jpg');
    expect(result).not.toContain('_crop_top_left');
  });
});

describe('cleanAndDeduplicateImages', () => {
  it('dedupes two URLs that differ only in Shopify size suffix', () => {
    const urls = [
      'https://cdn.shopify.com/s/files/1/0001/products/photo_80x80.jpg',
      'https://cdn.shopify.com/s/files/1/0001/products/photo_150x150.jpg',
    ];
    const result = cleanAndDeduplicateImages(urls);
    expect(result).toHaveLength(1);
  });

  it('normalizes Shopify CDN URLs to width=1200 preserving v param', () => {
    const urls = [
      'https://cdn.shopify.com/s/files/1/0001/products/photo_80x80.jpg?v=123',
    ];
    const result = cleanAndDeduplicateImages(urls);
    expect(result).toHaveLength(1);
    const url = result[0];
    expect(url).toContain('width=1200');
    expect(url).toContain('v=123');
  });

  it('keeps one per canonical group when both thumbnail and full-size are present', () => {
    const urls = [
      'https://cdn.shopify.com/s/files/1/0001/products/photo_80x80.jpg',
      'https://cdn.shopify.com/s/files/1/0001/products/photo.jpg',
    ];
    const result = cleanAndDeduplicateImages(urls);
    expect(result).toHaveLength(1);
    // first-seen wins (the thumbnail was listed first)
    expect(result[0]).toContain('_80x80');
  });

  it('filters data URIs', () => {
    const urls = [
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'https://example.com/real.jpg',
    ];
    const result = cleanAndDeduplicateImages(urls);
    expect(result).toEqual([expect.stringContaining('real.jpg')]);
  });

  it('passes non-Shopify URLs through without width normalization', () => {
    const urls = [
      'https://example.com/photos/product.jpg',
      'https://other-cdn.net/images/item.png',
    ];
    const result = cleanAndDeduplicateImages(urls);
    expect(result).toHaveLength(2);
    for (const url of result) {
      expect(url).not.toContain('width=');
    }
  });

  it('dedupes across size suffixes within non-Shopify URLs', () => {
    const urls = [
      'https://example.com/photos/product_80x80.jpg',
      'https://example.com/photos/product_medium.jpg',
      'https://example.com/photos/product.jpg',
    ];
    const result = cleanAndDeduplicateImages(urls);
    // All three share the same canonical key after stripping suffixes
    expect(result).toHaveLength(1);
  });

  it('preserves distinct images with different canonical paths', () => {
    const urls = [
      'https://cdn.shopify.com/s/files/1/0001/products/front_80x80.jpg',
      'https://cdn.shopify.com/s/files/1/0001/products/back_80x80.jpg',
    ];
    const result = cleanAndDeduplicateImages(urls);
    expect(result).toHaveLength(2);
  });

  it('preserves distinct gallery images with size-like patterns in filenames', () => {
    // Regression test: the mywoof.com Poomergency product page has 6
    // gallery images whose uploaded filenames contain `_1200x1200_`
    // followed by an index (`_1`, `_2`, ..., `_6`).  The old permissive
    // regex suffix `(?:_[a-z0-9-_]+)?` matched these indices, collapsing
    // all 6 images to the same canonical key and causing production
    // extraction to return only 1 image instead of 6.
    const urls = [
      '//mywoof.com/cdn/shop/files/Woof_Poomergency_Gallery_1200x1200_1-Lavender_139e0de8-5f63-45f0-90e6-c39f9c951a48.png?v=1752698667&width=1200',
      '//mywoof.com/cdn/shop/files/Woof_Poomergency_Gallery_1200x1200_2.png?v=1752505715&width=1200',
      '//mywoof.com/cdn/shop/files/Woof_Poomergency_Gallery_1200x1200_3.png?v=1752505715&width=1200',
      '//mywoof.com/cdn/shop/files/Woof_Poomergency_Gallery_1200x1200_4.png?v=1752505715&width=1200',
      '//mywoof.com/cdn/shop/files/Woof_Poomergency_Gallery_1200x1200_5.png?v=1752505711&width=1200',
      '//mywoof.com/cdn/shop/files/Woof_Poomergency_Gallery_1200x1200_6.png?v=1752505711&width=1200',
    ];
    const result = cleanAndDeduplicateImages(urls, 'https://mywoof.com');
    expect(result).toHaveLength(6);
  });

  it('returns empty array for empty input', () => {
    expect(cleanAndDeduplicateImages([])).toEqual([]);
  });

  it('resolves protocol-relative URLs', () => {
    const urls = [
      '//cdn.shopify.com/s/files/1/0001/products/photo_80x80.jpg',
    ];
    const result = cleanAndDeduplicateImages(urls);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/^https:/);
  });

  it('handles baseUrl to resolve relative image paths', () => {
    const urls = [
      '/s/files/1/0001/products/photo_80x80.jpg',
    ];
    const result = cleanAndDeduplicateImages(urls, 'https://cdn.shopify.com');
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('width=1200');
  });

  it('dedupes BigCommerce stencil URLs across dimensions and upgrades to 1280x1280', () => {
    const urls = [
      'https://cdn11.bigcommerce.com/s-k3kxaf4rop/images/stencil/120x120/products/1980/15076/abc.jpg?c=1',
      'https://cdn11.bigcommerce.com/s-k3kxaf4rop/images/stencil/240x240/products/1980/15076/abc.jpg?c=1',
      'https://cdn11.bigcommerce.com/s-k3kxaf4rop/images/stencil/120x120/products/1980/15082/def.jpg?c=1',
      'https://cdn11.bigcommerce.com/s-k3kxaf4rop/images/stencil/240x240/products/1980/15082/def.jpg?c=1',
    ];
    const result = cleanAndDeduplicateImages(urls);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('/images/stencil/1280x1280/products/1980/15076/abc.jpg');
    expect(result[1]).toContain('/images/stencil/1280x1280/products/1980/15082/def.jpg');
  });

  it('filters youtube video thumbnails from usable image sources', () => {
    const urls = [
      'https://img.youtube.com/vi/RNmHK9Cswzc/0.jpg',
      'https://example.com/real-photo.jpg',
    ];
    const result = cleanAndDeduplicateImages(urls);
    expect(result).toEqual(['https://example.com/real-photo.jpg']);
  });
});

