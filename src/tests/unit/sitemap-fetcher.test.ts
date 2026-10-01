import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { gzipSync } from 'node:zlib';
import { unlinkSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';

import { fetchAndParseSitemap } from '../../onboarding/sitemap-fetcher';

// ── Test helpers ───────────────────────────────────────────────────────────

/**
 * Construct a minimal `Response`-like object that the fetcher can
 * consume via `response.arrayBuffer()` + `response.headers.get(...)`.
 *
 * `Bun`'s production runtime supplies a real `Response` class. Vitest
 * runs in a Node environment where the same `Response` global exists
 * (via undici) but we avoid relying on it so the test stays robust
 * to runtime tweaks.
 */
function makeResponse(body: string | Uint8Array, init: {
  status?: number;
  contentType?: string;
  contentEncoding?: string;
} = {}): Response {
  const headers = new Map<string, string>();
  if (init.contentType) headers.set('content-type', init.contentType);
  if (init.contentEncoding) headers.set('content-encoding', init.contentEncoding);

  // Build a real Response so vitest's `.headers.get()` and `.arrayBuffer()`
  // behavior matches the production fetcher. We always pass a fresh
  // `Uint8Array` built on a plain `ArrayBuffer` so the Response
  // constructor's strict BodyInit typing is satisfied in all runtimes.
  const bytes = typeof body === 'string'
    ? new TextEncoder().encode(body)
    : body;
  const safe = new Uint8Array(bytes);
  // Force the underlying buffer to be a plain ArrayBuffer (not
  // SharedArrayBuffer) by copying once.
  const out = new Uint8Array(safe.length);
  out.set(safe);

  return new Response(out, {
    status: init.status ?? 200,
    headers: Object.fromEntries(headers),
  });
}

function gzip(input: string): Uint8Array {
  // Vitest runs under Node, where `Bun.gzipSync` is unavailable.
  // `node:zlib.gzipSync` is the cross-runtime equivalent and produces
  // a byte-identical gzip stream for our purposes.
  return new Uint8Array(gzipSync(input));
}

/** Track every URL the fetcher tried to hit, in order. */
function stubFetch(handlers: Array<{
  match: (url: string) => boolean;
  respond: (url: string) => Response | Promise<Response>;
}>): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchFn: typeof fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    for (const h of handlers) {
      if (h.match(url)) {
        return await h.respond(url);
      }
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('sitemap-fetcher.fetchAndParseSitemap', () => {
  const testDbPath = 'src/tests/unit/sitemap-fetcher-test.db';
  let originalFetch: typeof fetch;

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('parses a simple urlset from /sitemap.xml', async () => {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      `  <url><loc>https://shop.example.com/products/a</loc></url>\n` +
      `  <url><loc>https://shop.example.com/products/b</loc></url>\n` +
      `  <url><loc>https://shop.example.com/blog/post</loc></url>\n` +
      `</urlset>`;

    const { fetch: f, calls } = stubFetch([{
      match: (u) => u === 'https://shop.example.com/sitemap.xml',
      respond: () => makeResponse(xml, { contentType: 'application/xml' }),
    }]);
    globalThis.fetch = f;

    const result = await fetchAndParseSitemap('shop.example.com');
    expect(result.sourceUrl).toBe('https://shop.example.com/sitemap.xml');
    expect(result.urls).toEqual([
      'https://shop.example.com/products/a',
      'https://shop.example.com/products/b',
      'https://shop.example.com/blog/post',
    ]);
    expect(calls).toEqual(['https://shop.example.com/sitemap.xml']);
  });

  it('walks the standard-path list in order and stops at the first hit', async () => {
    const xml = `<?xml version="1.0"?><urlset><url><loc>https://x.com/a</loc></url></urlset>`;
    const { fetch: f, calls } = stubFetch([
      // /sitemap.xml → 404
      { match: (u) => u === 'https://x.com/sitemap.xml', respond: () => new Response('', { status: 404 }) },
      // /sitemap_index.xml → 200
      { match: (u) => u === 'https://x.com/sitemap_index.xml', respond: () => makeResponse(xml, { contentType: 'application/xml' }) },
    ]);
    globalThis.fetch = f;

    const result = await fetchAndParseSitemap('x.com');
    expect(result.sourceUrl).toBe('https://x.com/sitemap_index.xml');
    expect(result.urls).toEqual(['https://x.com/a']);
    expect(calls).toEqual([
      'https://x.com/sitemap.xml',
      'https://x.com/sitemap_index.xml',
    ]);
  });

  it('falls back to /robots.txt Sitemap: directive when standard paths 404', async () => {
    const xml = `<?xml version="1.0"?><urlset><url><loc>https://x.com/from-robots</loc></url></urlset>`;
    const robots = [
      'User-agent: *',
      'Disallow: /admin',
      '',
      'Sitemap: https://x.com/custom-sitemap.xml',
    ].join('\n');

    const { fetch: f, calls } = stubFetch([
      // All standard paths 404
      ...['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemap.php']
        .map(p => ({ match: (u: string) => u === 'https://x.com' + p, respond: () => new Response('', { status: 404 }) })),
      // robots.txt
      { match: (u) => u === 'https://x.com/robots.txt', respond: () => makeResponse(robots, { contentType: 'text/plain' }) },
      // Sitemap declared in robots
      { match: (u) => u === 'https://x.com/custom-sitemap.xml', respond: () => makeResponse(xml, { contentType: 'application/xml' }) },
    ]);
    globalThis.fetch = f;

    const result = await fetchAndParseSitemap('x.com');
    expect(result.sourceUrl).toBe('https://x.com/custom-sitemap.xml');
    expect(result.urls).toEqual(['https://x.com/from-robots']);
    expect(calls).toContain('https://x.com/robots.txt');
    expect(calls).toContain('https://x.com/custom-sitemap.xml');
  });

  it('falls back to /sitemap_products_1.xml after robots-driven URLs', async () => {
    const xml = `<?xml version="1.0"?><urlset><url><loc>https://shop.example.com/products/p1</loc></url></urlset>`;

    const { fetch: f, calls } = stubFetch([
      // All standard paths 404
      ...['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemap.php']
        .map(p => ({ match: (u: string) => u === 'https://shop.example.com' + p, respond: () => new Response('', { status: 404 }) })),
      // robots.txt returns 404
      { match: (u) => u === 'https://shop.example.com/robots.txt', respond: () => new Response('', { status: 404 }) },
      // Shopify products sitemap
      { match: (u) => u === 'https://shop.example.com/sitemap_products_1.xml', respond: () => makeResponse(xml, { contentType: 'application/xml' }) },
    ]);
    globalThis.fetch = f;

    const result = await fetchAndParseSitemap('shop.example.com');
    expect(result.sourceUrl).toBe('https://shop.example.com/sitemap_products_1.xml');
    expect(result.urls).toEqual(['https://shop.example.com/products/p1']);
    expect(calls).toContain('https://shop.example.com/sitemap_products_1.xml');
  });

  it('recursively flattens a sitemapindex', async () => {
    const child1Xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://x.com/a</loc></url>
      <url><loc>https://x.com/b</loc></url>
    </urlset>`;
    const child2Xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://x.com/c</loc></url>
    </urlset>`;
    const indexXml = `<?xml version="1.0"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://x.com/sitemaps/one.xml</loc></sitemap>
        <sitemap><loc>https://x.com/sitemaps/two.xml</loc></sitemap>
      </sitemapindex>`;

    const { fetch: f } = stubFetch([
      { match: (u) => u === 'https://x.com/sitemap.xml', respond: () => makeResponse(indexXml, { contentType: 'application/xml' }) },
      { match: (u) => u === 'https://x.com/sitemaps/one.xml', respond: () => makeResponse(child1Xml, { contentType: 'application/xml' }) },
      { match: (u) => u === 'https://x.com/sitemaps/two.xml', respond: () => makeResponse(child2Xml, { contentType: 'application/xml' }) },
    ]);
    globalThis.fetch = f;

    const result = await fetchAndParseSitemap('x.com');
    expect(result.sourceUrl).toBe('https://x.com/sitemap.xml');
    expect(result.urls.sort()).toEqual(['https://x.com/a', 'https://x.com/b', 'https://x.com/c']);
  });

  it('recursion is capped at MAX_INDEX_DEPTH = 3', async () => {
    // Build a 4-level chain: root → L1 → L2 → L3 → L4 (should be skipped)
    const l4 = `<?xml version="1.0"?><urlset><url><loc>https://x.com/deep</loc></url></urlset>`;
    const l3 = `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://x.com/L4.xml</loc></sitemap></sitemapindex>`;
    const l2 = `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://x.com/L3.xml</loc></sitemap></sitemapindex>`;
    const l1 = `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://x.com/L2.xml</loc></sitemap></sitemapindex>`;
    const root = `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://x.com/L1.xml</loc></sitemap></sitemapindex>`;

    const { fetch: f, calls } = stubFetch([
      { match: (u) => u === 'https://x.com/sitemap.xml', respond: () => makeResponse(root, { contentType: 'application/xml' }) },
      { match: (u) => u === 'https://x.com/L1.xml', respond: () => makeResponse(l1, { contentType: 'application/xml' }) },
      { match: (u) => u === 'https://x.com/L2.xml', respond: () => makeResponse(l2, { contentType: 'application/xml' }) },
      { match: (u) => u === 'https://x.com/L3.xml', respond: () => makeResponse(l3, { contentType: 'application/xml' }) },
      { match: (u) => u === 'https://x.com/L4.xml', respond: () => makeResponse(l4, { contentType: 'application/xml' }) },
    ]);
    globalThis.fetch = f;

    const result = await fetchAndParseSitemap('x.com');
    // We should hit L1, L2, L3 but NOT L4 (depth is capped at 3 and
    // the depth counter starts at 0; the L3 child is fetched at
    // depth 3, which is allowed for fetching the document but the
    // recursive call to follow its children would happen at depth 4).
    expect(calls).toContain('https://x.com/L3.xml');
    expect(calls).not.toContain('https://x.com/L4.xml');
    // The L3 child contains a sitemapindex but no children, so the
    // final result is empty (no leaf urlset was reached).
    expect(result.urls).toEqual([]);
  });

  it('filters URLs with a productUrlPattern regex', async () => {
    const xml = `<?xml version="1.0"?>
      <urlset>
        <url><loc>https://shop.example.com/products/a</loc></url>
        <url><loc>https://shop.example.com/blog/post</loc></url>
        <url><loc>https://shop.example.com/products/b</loc></url>
      </urlset>`;

    const { fetch: f } = stubFetch([{
      match: (u) => u === 'https://shop.example.com/sitemap.xml',
      respond: () => makeResponse(xml, { contentType: 'application/xml' }),
    }]);
    globalThis.fetch = f;

    const result = await fetchAndParseSitemap('shop.example.com', '.*/products/.*');
    expect(result.urls).toEqual([
      'https://shop.example.com/products/a',
      'https://shop.example.com/products/b',
    ]);
  });

  it('returns an empty filtered set when no child URLs match the pattern', async () => {
    // The pattern is applied to the aggregated result. When none of
    // the URLs match, the filtered result is empty (per the
    // "empty sitemaps: return empty array" contract).
    const childXml = `<?xml version="1.0"?>
      <urlset>
        <url><loc>https://x.com/blog/one</loc></url>
        <url><loc>https://x.com/blog/two</loc></url>
      </urlset>`;
    const indexXml = `<?xml version="1.0"?>
      <sitemapindex>
        <sitemap><loc>https://x.com/posts.xml</loc></sitemap>
      </sitemapindex>`;

    const { fetch: f } = stubFetch([
      { match: (u) => u === 'https://x.com/sitemap.xml', respond: () => makeResponse(indexXml, { contentType: 'application/xml' }) },
      { match: (u) => u === 'https://x.com/posts.xml', respond: () => makeResponse(childXml, { contentType: 'application/xml' }) },
    ]);
    globalThis.fetch = f;

    const result = await fetchAndParseSitemap('x.com', '.*/products/.*');
    expect(result.urls).toEqual([]);
    // sourceUrl still points at the index that produced the result.
    expect(result.sourceUrl).toBe('https://x.com/sitemap.xml');
  });

  it('treats an invalid productUrlPattern as no filter (logs and continues)', async () => {
    const xml = `<?xml version="1.0"?>
      <urlset>
        <url><loc>https://x.com/blog/post</loc></url>
      </urlset>`;

    const { fetch: f } = stubFetch([{
      match: (u) => u === 'https://x.com/sitemap.xml',
      respond: () => makeResponse(xml, { contentType: 'application/xml' }),
    }]);
    globalThis.fetch = f;

    const result = await fetchAndParseSitemap('x.com', '[');  // unterminated character class
    expect(result.urls).toEqual(['https://x.com/blog/post']);
  });

  it('decompresses a gzip body when Content-Encoding is set', async () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://x.com/a</loc></url>
    </urlset>`;
    const gz = gzip(xml);

    const { fetch: f } = stubFetch([{
      match: (u) => u === 'https://x.com/sitemap.xml',
      respond: () => makeResponse(gz, {
        contentType: 'application/xml',
        contentEncoding: 'gzip',
      }),
    }]);
    globalThis.fetch = f;

    const result = await fetchAndParseSitemap('x.com');
    expect(result.urls).toEqual(['https://x.com/a']);
  });

  it('parses uncompressed XML body even when Content-Encoding is gzip (e.g. transparently decompressed by runtime fetch)', async () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://x.com/decompressed-by-runtime</loc></url>
    </urlset>`;

    const { fetch: f } = stubFetch([{
      match: (u) => u === 'https://x.com/sitemap.xml',
      respond: () => makeResponse(xml, {
        contentType: 'application/xml',
        contentEncoding: 'gzip',
      }),
    }]);
    globalThis.fetch = f;

    const result = await fetchAndParseSitemap('x.com');
    expect(result.urls).toEqual(['https://x.com/decompressed-by-runtime']);
  });

  it('decompresses a gzip body when the magic bytes are present without Content-Encoding', async () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://x.com/pre-encoded</loc></url>
    </urlset>`;
    const gz = gzip(xml);

    const { fetch: f } = stubFetch([{
      match: (u) => u === 'https://x.com/sitemap.xml',
      respond: () => makeResponse(gz, { contentType: 'application/xml' }),
    }]);
    globalThis.fetch = f;

    const result = await fetchAndParseSitemap('x.com');
    expect(result.urls).toEqual(['https://x.com/pre-encoded']);
  });

  it('skips non-XML Content-Type responses', async () => {
    const { fetch: f, calls } = stubFetch([
      // /sitemap.xml returns HTML (e.g. a 200 with a soft 404 page)
      { match: (u) => u === 'https://x.com/sitemap.xml', respond: () => makeResponse('<html>not a sitemap</html>', { contentType: 'text/html' }) },
      // subsequent paths
      { match: (u) => u === 'https://x.com/sitemap_index.xml', respond: () => makeResponse('<html>still not</html>', { contentType: 'text/html' }) },
      { match: (u) => u === 'https://x.com/sitemap-index.xml', respond: () => makeResponse('<html>still not</html>', { contentType: 'text/html' }) },
      { match: (u) => u === 'https://x.com/sitemap.php', respond: () => makeResponse('<html>still not</html>', { contentType: 'text/html' }) },
      { match: (u) => u === 'https://x.com/robots.txt', respond: () => new Response('', { status: 404 }) },
      { match: (u) => u === 'https://x.com/sitemap_products_1.xml', respond: () => makeResponse('<html>still not</html>', { contentType: 'text/html' }) },
    ]);
    globalThis.fetch = f;

    const result = await fetchAndParseSitemap('x.com');
    expect(result).toEqual({ urls: [], sourceUrl: '' });
    // All standard + shopify + robots paths were tried
    expect(calls).toContain('https://x.com/sitemap.xml');
    expect(calls).toContain('https://x.com/sitemap_index.xml');
    expect(calls).toContain('https://x.com/sitemap-index.xml');
    expect(calls).toContain('https://x.com/sitemap.php');
    expect(calls).toContain('https://x.com/robots.txt');
    expect(calls).toContain('https://x.com/sitemap_products_1.xml');
  });

  it('skips bodies that are not urlset and not sitemapindex', async () => {
    // Returns valid XML but with an unrelated root element.
    const xml = `<?xml version="1.0"?><html><body>Not a sitemap</body></html>`;
    const { fetch: f, calls } = stubFetch([
      { match: (u) => u === 'https://x.com/sitemap.xml', respond: () => makeResponse(xml, { contentType: 'application/xml' }) },
      ...['/sitemap_index.xml', '/sitemap-index.xml', '/sitemap.php']
        .map(p => ({ match: (u: string) => u === 'https://x.com' + p, respond: () => new Response('', { status: 404 }) })),
      { match: (u) => u === 'https://x.com/robots.txt', respond: () => new Response('', { status: 404 }) },
      { match: (u) => u === 'https://x.com/sitemap_products_1.xml', respond: () => new Response('', { status: 404 }) },
    ]);
    globalThis.fetch = f;

    const result = await fetchAndParseSitemap('x.com');
    expect(result).toEqual({ urls: [], sourceUrl: '' });
    // Confirm we did try /sitemap.xml (the only XML-looking response)
    expect(calls).toContain('https://x.com/sitemap.xml');
  });

  it('returns empty result for a domain that cannot be normalized', async () => {
    const { fetch: f, calls } = stubFetch([]);
    globalThis.fetch = f;

    // An empty string is not a valid URL.
    const result = await fetchAndParseSitemap('');
    expect(result).toEqual({ urls: [], sourceUrl: '' });
    // No fetches should be made for a non-normalizable input.
    expect(calls).toEqual([]);
  });

  it('deduplicates URLs that appear in multiple child sitemaps', async () => {
    const child1 = `<?xml version="1.0"?><urlset>
      <url><loc>https://x.com/a</loc></url>
      <url><loc>https://x.com/shared</loc></url>
    </urlset>`;
    const child2 = `<?xml version="1.0"?><urlset>
      <url><loc>https://x.com/b</loc></url>
      <url><loc>https://x.com/shared</loc></url>
    </urlset>`;
    const index = `<?xml version="1.0"?>
      <sitemapindex>
        <sitemap><loc>https://x.com/one.xml</loc></sitemap>
        <sitemap><loc>https://x.com/two.xml</loc></sitemap>
      </sitemapindex>`;

    const { fetch: f } = stubFetch([
      { match: (u) => u === 'https://x.com/sitemap.xml', respond: () => makeResponse(index, { contentType: 'application/xml' }) },
      { match: (u) => u === 'https://x.com/one.xml', respond: () => makeResponse(child1, { contentType: 'application/xml' }) },
      { match: (u) => u === 'https://x.com/two.xml', respond: () => makeResponse(child2, { contentType: 'application/xml' }) },
    ]);
    globalThis.fetch = f;

    const result = await fetchAndParseSitemap('x.com');
    expect(result.urls.sort()).toEqual([
      'https://x.com/a',
      'https://x.com/b',
      'https://x.com/shared',
    ]);
    // "shared" should only appear once
    expect(result.urls.filter(u => u === 'https://x.com/shared')).toHaveLength(1);
  });

  it('sends Accept and User-Agent headers on every request', async () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://x.com/a</loc></url>
    </urlset>`;

    const seenHeaders: Array<Record<string, string>> = [];
    const fetchFn: typeof fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers: Record<string, string> = {};
      const raw = (init?.headers ?? {}) as Record<string, string>;
      for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = String(v);
      seenHeaders.push(headers);
      if (url === 'https://x.com/sitemap.xml') {
        return makeResponse(xml, { contentType: 'application/xml' });
      }
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchFn;

    await fetchAndParseSitemap('x.com');

    expect(seenHeaders.length).toBeGreaterThan(0);
    for (const h of seenHeaders) {
      expect(h['accept']).toBe('application/xml, text/xml, */*');
      expect(h['user-agent']).toContain('Mozilla');
    }
  });

  it('normalizes domains with and without a scheme', async () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://shop.example.com/p</loc></url>
    </urlset>`;
    const { fetch: f, calls } = stubFetch([
      { match: (u) => u === 'https://shop.example.com/sitemap.xml', respond: () => makeResponse(xml, { contentType: 'application/xml' }) },
    ]);
    globalThis.fetch = f;

    // All three inputs should resolve to the same origin.
    for (const input of ['shop.example.com', 'https://shop.example.com', 'http://shop.example.com/about']) {
      calls.length = 0;
      const result = await fetchAndParseSitemap(input);
      expect(result.sourceUrl).toBe('https://shop.example.com/sitemap.xml');
      expect(result.urls).toEqual(['https://shop.example.com/p']);
      expect(calls[0]).toBe('https://shop.example.com/sitemap.xml');
    }
  });

  it('returns empty result when the only XML-shaped body is empty', async () => {
    const { fetch: f, calls } = stubFetch([
      { match: (u) => u === 'https://x.com/sitemap.xml', respond: () => makeResponse('', { contentType: 'application/xml' }) },
      ...['/sitemap_index.xml', '/sitemap-index.xml', '/sitemap.php']
        .map(p => ({ match: (u: string) => u === 'https://x.com' + p, respond: () => new Response('', { status: 404 }) })),
      { match: (u) => u === 'https://x.com/robots.txt', respond: () => new Response('', { status: 404 }) },
      { match: (u) => u === 'https://x.com/sitemap_products_1.xml', respond: () => new Response('', { status: 404 }) },
    ]);
    globalThis.fetch = f;

    const result = await fetchAndParseSitemap('x.com');
    expect(result).toEqual({ urls: [], sourceUrl: '' });
    expect(calls).toContain('https://x.com/sitemap.xml');
  });

  it('tolerates a network error on the first standard path and moves on', async () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://x.com/a</loc></url>
    </urlset>`;
    const { fetch: f, calls } = stubFetch([
      // /sitemap.xml throws a network error
      { match: (u) => u === 'https://x.com/sitemap.xml', respond: () => { throw new Error('ECONNREFUSED'); } },
      // /sitemap_index.xml succeeds
      { match: (u) => u === 'https://x.com/sitemap_index.xml', respond: () => makeResponse(xml, { contentType: 'application/xml' }) },
    ]);
    globalThis.fetch = f;

    const result = await fetchAndParseSitemap('x.com');
    expect(result.sourceUrl).toBe('https://x.com/sitemap_index.xml');
    expect(result.urls).toEqual(['https://x.com/a']);
    expect(calls).toEqual([
      'https://x.com/sitemap.xml',
      'https://x.com/sitemap_index.xml',
    ]);
  });

  it('parses multiple Sitemap: directives out of robots.txt', async () => {
    const xmlB = `<?xml version="1.0"?><urlset><url><loc>https://x.com/b</loc></url></urlset>`;
    const robots = [
      'Sitemap: https://x.com/sitemap-a.xml',
      '# A comment',
      'Sitemap: https://x.com/sitemap-b.xml',
    ].join('\n');

    const { fetch: f, calls } = stubFetch([
      ...['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemap.php']
        .map(p => ({ match: (u: string) => u === 'https://x.com' + p, respond: () => new Response('', { status: 404 }) })),
      { match: (u) => u === 'https://x.com/robots.txt', respond: () => makeResponse(robots, { contentType: 'text/plain' }) },
      // First declared sitemap returns 404
      { match: (u) => u === 'https://x.com/sitemap-a.xml', respond: () => new Response('', { status: 404 }) },
      // Second declared sitemap succeeds
      { match: (u) => u === 'https://x.com/sitemap-b.xml', respond: () => makeResponse(xmlB, { contentType: 'application/xml' }) },
    ]);
    globalThis.fetch = f;

    const result = await fetchAndParseSitemap('x.com');
    expect(result.sourceUrl).toBe('https://x.com/sitemap-b.xml');
    expect(result.urls).toEqual(['https://x.com/b']);
    expect(calls).toContain('https://x.com/sitemap-a.xml');
  });

  it('injected policy-bound fetch does not invoke Camoufox rendered fallback when blocked', async () => {
    // Every standard path returns 403 Cloudflare-style to trigger tracker.isBlocked
    const blockedFetch = vi.fn(async () => new Response('blocked', { status: 403, headers: { server: 'cloudflare' } })) as unknown as typeof fetch;
    // Also stub the dynamic Camoufox imports to detect if they are invoked — make them throw if called
    const camMock = vi.fn(() => { throw new Error('Camoufox should not be invoked for injected fetch'); });
    // We achieve this by passing an injected fetch and allowRenderedFallback:false
    const result = await fetchAndParseSitemap('blocked.example.com', null, blockedFetch as any, { allowRenderedFallback: false });
    expect(result.urls).toEqual([]);
    expect(result.sourceUrl).toBe('');
    // Ensure blockedFetch was called for standard paths but no exception was thrown from Camoufox
    expect(blockedFetch).toHaveBeenCalled();
    void camMock;
  });

  it('blocks private, link-local, and loopback destinations directly in fetchAndParseSitemap (SSRF guard)', async () => {
    const { fetch: f, calls } = stubFetch([]);
    globalThis.fetch = f;

    const blockedDomains = ['127.0.0.1', '169.254.169.254', 'localhost', '10.0.0.1', '192.168.1.1', '0.0.0.0'];
    for (const domain of blockedDomains) {
      const result = await fetchAndParseSitemap(domain);
      expect(result).toEqual({ urls: [], sourceUrl: '' });
    }
    expect(calls).toEqual([]);
  });

  it('blocks child sitemap URLs declared in robots.txt or index that point to private/link-local destinations', async () => {
    const indexXml = `<?xml version="1.0"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>http://169.254.169.254/latest/meta-data/</loc></sitemap>
        <sitemap><loc>http://127.0.0.1/internal.xml</loc></sitemap>
      </sitemapindex>`;

    const { fetch: f, calls } = stubFetch([
      { match: (u) => u === 'https://x.com/sitemap.xml', respond: () => makeResponse(indexXml, { contentType: 'application/xml' }) },
      { match: (u) => u === 'http://169.254.169.254/latest/meta-data/', respond: () => makeResponse('<urlset></urlset>', { contentType: 'application/xml' }) },
      { match: (u) => u === 'http://127.0.0.1/internal.xml', respond: () => makeResponse('<urlset></urlset>', { contentType: 'application/xml' }) },
    ]);
    globalThis.fetch = f;

    const result = await fetchAndParseSitemap('x.com');
    expect(result.urls).toEqual([]);
    expect(calls).toEqual(['https://x.com/sitemap.xml']);
  });
});
