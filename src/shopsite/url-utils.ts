const CGI_FILE_RE = /\/[^/?#]+\.cgi(?:[?#].*)?$/i;

/**
 * Normalize a merchant-supplied ShopSite CGI URL into the CGI directory URL.
 * Accepts either a CGI directory (`.../cgi-bin/bo`) or a concrete script
 * (`.../cgi-bin/bo/db_xml.cgi`). Query strings/fragments are ignored.
 */
export function normalizeCgiBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';

  const withoutFragment = trimmed.split('#', 1)[0];
  const withoutQuery = withoutFragment.split('?', 1)[0];
  const withoutTrailingSlash = withoutQuery.replace(/\/+$/, '');

  if (CGI_FILE_RE.test(withoutTrailingSlash)) {
    return withoutTrailingSlash.replace(CGI_FILE_RE, '');
  }

  return withoutTrailingSlash;
}

/**
 * Validate a ShopSite CGI URL for safety.
 * Returns null if valid, or an error message string if validation fails.
 */
export function validateCgiUrl(input: string): string | null {
  const base = normalizeCgiBaseUrl(input);
  if (!base) return 'URL is empty.';

  try {
    const parsed = new URL(base.startsWith('http') ? base : `http://${base}`);

    // Reject non-http(s)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'Only HTTP and HTTPS URLs are supported.';
    }

    // Reject embedded userinfo
    if (parsed.username) {
      return 'URL must not contain embedded username/password.';
    }

    // For non-loopback hosts, require HTTPS
    const hostname = parsed.hostname.toLowerCase();
    const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (!isLoopback && parsed.protocol === 'http:') {
      return 'HTTPS is required for non-loopback ShopSite connections.';
    }

    return null;
  } catch {
    return 'Invalid URL format.';
  }
}

export function buildCgiScriptUrl(baseUrl: string, scriptName: string, params?: Record<string, string>): string {
  const base = normalizeCgiBaseUrl(baseUrl);
  const cleanScript = scriptName.replace(/^\/+/, '');
  let url = `${base}/${cleanScript}`;
  if (params && Object.keys(params).length > 0) {
    url += `?${new URLSearchParams(params).toString()}`;
  }
  return url;
}

/**
 * Derive the storefront media base (`https://<host>/media/`) from a ShopSite
 * CGI base URL. ShopSite stores only the path suffix of product images
 * (e.g. `brand/foo.jpg`); the domain is never persisted on the product.
 * Returns '' when the base URL is unparseable.
 */
export function buildStorefrontMediaBaseUrl(cgiBaseUrl: string): string {
  const base = normalizeCgiBaseUrl(cgiBaseUrl);
  if (!base) return '';
  try {
    const parsed = new URL(base);
    return `${parsed.protocol}//${parsed.host}/media/`;
  } catch {
    return '';
  }
}

/**
 * Resolve a stored ShopSite image reference to a fetchable URL.
 * Absolute http(s) references pass through; bare paths (with or without a
 * brand subdirectory) join onto the media base derived from the CGI URL.
 * Path segments are percent-encoded (stored names may contain spaces).
 * Returns the original reference when no media base is available.
 */
export function resolveProductImageUrl(imageRef: string, cgiBaseUrl: string): string {
  const trimmed = imageRef.trim();
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const mediaBase = buildStorefrontMediaBaseUrl(cgiBaseUrl);
  if (!mediaBase) return trimmed;
  const encoded = trimmed.replace(/^\/+/, '').split('/').map(seg => encodeURIComponent(seg)).join('/');
  return `${mediaBase}${encoded}`;
}
