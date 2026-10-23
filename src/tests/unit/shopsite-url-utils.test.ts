import { describe, expect, it } from 'vitest';
import { buildStorefrontMediaBaseUrl, resolveProductImageUrl } from '../../shopsite/url-utils';

const CGI = 'https://www.baystatepet.com/cgi-baystatepet/bo';

describe('buildStorefrontMediaBaseUrl', () => {
  it('derives the media base from the CGI directory URL', () => {
    expect(buildStorefrontMediaBaseUrl(CGI)).toBe('https://www.baystatepet.com/media/');
  });

  it('accepts a concrete CGI script URL', () => {
    expect(buildStorefrontMediaBaseUrl(`${CGI}/db_xml.cgi`)).toBe('https://www.baystatepet.com/media/');
  });

  it('returns empty string for unparseable input', () => {
    expect(buildStorefrontMediaBaseUrl('')).toBe('');
    expect(buildStorefrontMediaBaseUrl('not a url')).toBe('');
  });
});

describe('resolveProductImageUrl', () => {
  it('joins bare subdirectory paths onto the media base', () => {
    expect(resolveProductImageUrl('nylabone/foo.jpg', CGI)).toBe(
      'https://www.baystatepet.com/media/nylabone/foo.jpg',
    );
  });

  it('joins bare filenames onto the media base', () => {
    expect(resolveProductImageUrl('foo.jpg', CGI)).toBe('https://www.baystatepet.com/media/foo.jpg');
  });

  it('passes absolute URLs through untouched', () => {
    const abs = 'https://cdn.example.com/x/foo.jpg';
    expect(resolveProductImageUrl(abs, CGI)).toBe(abs);
  });

  it('percent-encodes segments with spaces', () => {
    expect(resolveProductImageUrl('brand/my toy.jpg', CGI)).toBe(
      'https://www.baystatepet.com/media/brand/my%20toy.jpg',
    );
  });

  it('returns the original reference when no media base is available', () => {
    expect(resolveProductImageUrl('brand/foo.jpg', '')).toBe('brand/foo.jpg');
  });
});
