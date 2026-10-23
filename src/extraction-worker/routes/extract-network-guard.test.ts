/**
 * Worker profile-runner network guards + provenance details (issue #52 fix 3).
 *
 * Covers:
 *   - static/rendered profile fetches enforce SSRF AND the profile's explicit
 *     source-domain allowlist on the initial request and on EVERY redirect hop
 *     (redirect revalidation, no fetch to a denied hop);
 *   - rendered extraction has ONE authoritative network guard (trackers,
 *     private destinations, out-of-allowlist public destinations all abort);
 *   - fieldProvenanceDetails carries the TRUE method/path per field (never a
 *     fabricated JSON-LD path for meta/microdata/fallback values), verified
 *     end-to-end through the static extractor.
 *
 * Bun test — the parent registers this file in package.json test:db.
 * (vitest does not discover files outside src/tests/, so no exclude needed.)
 */
import { describe, it, expect } from 'bun:test';
import {
  assertSafeProfileDestination,
  safeProfileFetch,
  profileNetworkGuard,
  buildFieldProvenanceDetails,
  doStaticExtract,
} from './extract';
import type { ExtractRequest } from '../../shared/schemas/extraction-worker';
import {
  guardedRouteHandler,
  buildGuardPreNavigationHooks,
  type GuardedPage,
  type GuardedRoute,
} from '../browser/rendered-page-runner';

const publicLookup = async (): Promise<Array<{ address: string }>> => [{ address: '203.0.113.7' }];
const privateLookup = async (): Promise<Array<{ address: string }>> => [{ address: '10.0.0.1' }];

function htmlResponse(body = '<html><body>ok</body></html>', status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } });
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

describe('assertSafeProfileDestination', () => {
  it('allows an in-allowlist public destination (www-normalized suffix match)', async () => {
    await expect(
      assertSafeProfileDestination('https://www.brand.example.com/p/1', ['brand.example.com'], { lookupFn: publicLookup }),
    ).resolves.toBeUndefined();
    await expect(
      assertSafeProfileDestination('https://cdn.brand.example.com/img/x.jpg', ['brand.example.com'], { lookupFn: publicLookup }),
    ).resolves.toBeUndefined();
  });

  it('denies a public destination outside the explicit allowlist', async () => {
    await expect(
      assertSafeProfileDestination('https://evil.example.com/p/1', ['brand.example.com'], { lookupFn: publicLookup }),
    ).rejects.toThrow(/outside allowed source domains/);
  });

  it('denies a private IP-literal destination even when the allowlist names it', async () => {
    await expect(
      assertSafeProfileDestination('https://10.0.0.5/p/1', ['10.0.0.5'], { lookupFn: publicLookup }),
    ).rejects.toThrow(/private or link-local/);
  });

  it('denies a suffix-allowlisted host whose DNS resolves private (SSRF + allowlist both required)', async () => {
    await expect(
      assertSafeProfileDestination('https://internal.brand.example.com/p/1', ['brand.example.com'], { lookupFn: privateLookup }),
    ).rejects.toThrow(/private or link-local DNS/);
  });

  it('denies unresolvable / non-public DNS fail closed', async () => {
    await expect(
      assertSafeProfileDestination('https://brand.example.com/p/1', [], { lookupFn: async () => [] }),
    ).rejects.toThrow(/private or link-local DNS/);
  });
});

describe('safeProfileFetch (static transport)', () => {
  it('revalidates every redirect hop against SSRF + allowlist before following', async () => {
    const calls: string[] = [];
    const fetchFn = async (input: string | URL | Request): Promise<Response> => {
      calls.push(String(input));
      return calls.length === 1 ? redirectResponse('https://cdn.brand.example.com/img') : htmlResponse();
    };
    const response = await safeProfileFetch(
      'https://brand.example.com/p/1',
      AbortSignal.timeout(5000),
      ['brand.example.com'],
      { lookupFn: publicLookup, fetchFn },
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual(['https://brand.example.com/p/1', 'https://cdn.brand.example.com/img']);
  });

  it('fails closed on a redirect to a public destination outside the allowlist (denied hop never fetched)', async () => {
    const calls: string[] = [];
    const fetchFn = async (input: string | URL | Request): Promise<Response> => {
      calls.push(String(input));
      return redirectResponse('https://evil.example.com/x');
    };
    await expect(
      safeProfileFetch('https://brand.example.com/p/1', AbortSignal.timeout(5000), ['brand.example.com'], { lookupFn: publicLookup, fetchFn }),
    ).rejects.toThrow(/outside allowed source domains/);
    expect(calls).toHaveLength(1);
  });

  it('fails closed on a redirect to a private destination', async () => {
    const fetchFn = async (): Promise<Response> => redirectResponse('https://10.0.0.5/x');
    await expect(
      safeProfileFetch('https://brand.example.com/p/1', AbortSignal.timeout(5000), ['brand.example.com'], { lookupFn: publicLookup, fetchFn }),
    ).rejects.toThrow(/private or link-local/);
  });

  it('enforces the redirect hop limit', async () => {
    let calls = 0;
    const fetchFn = async (): Promise<Response> => {
      calls += 1;
      return redirectResponse('https://brand.example.com/loop');
    };
    await expect(
      safeProfileFetch('https://brand.example.com/p/1', AbortSignal.timeout(5000), ['brand.example.com'], { lookupFn: publicLookup, fetchFn }),
    ).rejects.toThrow(/redirect limit exceeded/);
    expect(calls).toBe(6); // 5 redirects allowed, 6th hop rejected
  });
});

describe('profileNetworkGuard (rendered single authoritative route)', () => {
  it('allows an in-allowlist public request', async () => {
    expect(await profileNetworkGuard('https://brand.example.com/p/1', ['brand.example.com'], { lookupFn: publicLookup })).toBe(true);
  });

  it('aborts a public request outside the allowlist', async () => {
    expect(await profileNetworkGuard('https://evil.example.com/p/1', ['brand.example.com'], { lookupFn: publicLookup })).toBe(false);
  });

  it('aborts a private destination even when allowlisted', async () => {
    expect(await profileNetworkGuard('https://10.0.0.5/p/1', ['10.0.0.5'], { lookupFn: publicLookup })).toBe(false);
  });

  it('aborts tracker sub-resources', async () => {
    expect(await profileNetworkGuard('https://brand.example.com/analytics.js', ['brand.example.com'], { lookupFn: publicLookup })).toBe(false);
  });
});

describe('buildFieldProvenanceDetails', () => {
  it('maps declared provenance + origin into true method/path entries', () => {
    const details = buildFieldProvenanceDetails(
      {
        title: 'json-ld',
        brand: 'meta',
        description: 'profile-selector',
        price: 'profile-selector',
        sourceUrl: 'request',
        searchKeywords: 'derived',
      },
      {
        title: 'json-ld:Product.name',
        brand: 'meta:product:brand',
        description: '.desc',
        price: '.price',
      },
    );
    expect(details).toEqual({
      title: { method: 'json_ld', sourcePath: 'json-ld:Product.name' },
      brand: { method: 'meta', sourcePath: 'meta:product:brand' },
      description: { method: 'profile_selector', sourcePath: '.desc' },
    });
    expect(details).not.toHaveProperty('price');
    // Fields without a known origin are omitted (fail closed) — never fabricated.
    expect(details.sourceUrl).toBeUndefined();
    expect(details.searchKeywords).toBeUndefined();
  });
});

describe('doStaticExtract provenance details (end-to-end)', () => {
  function staticRequest(overrides: Partial<ExtractRequest> = {}): ExtractRequest {
    return {
      profileId: 'prof-1',
      profileVersion: 1,
      sourceUrl: 'https://brand.example.com/p/1',
      expected: { name: 'LD Name', brandHint: null, spreadsheetHints: {} },
      profile: {
        runtime: 'static',
        selectors: {},
        titleOptionalSelectors: [],
        customSelectors: {},
        imageRules: {},
        variantSelectionStrategy: null,
        allowedSourceDomains: [],
      },
      ...overrides,
    };
  }

  it('reports safe JSON-LD origins and excludes page prices', async () => {
    const html = `<html><head><title>Page</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"LD Name","description":"LD Desc","brand":{"name":"LD Brand"},"image":"https://img.example.com/ld.jpg","offers":{"price":"9.99"}}</script>
</head><body><h1>h1 text</h1></body></html>`;
    const result = await doStaticExtract(staticRequest(), {
      lookupFn: publicLookup,
      fetchFn: async () => htmlResponse(html),
    });
    expect(result.fieldProvenanceDetails).toEqual({
      title: { method: 'json_ld', sourcePath: 'json-ld:Product.name' },
      brand: { method: 'json_ld', sourcePath: 'json-ld:Product.brand' },
      description: { method: 'json_ld', sourcePath: 'json-ld:Product.description' },
      primaryImage: { method: 'json_ld', sourcePath: 'json-ld:Product.image' },
    });
    expect(result.fieldProvenanceDetails).not.toHaveProperty('price');
    expect(result.data.price).toBeNull();
  });

  it('reports safe meta/microdata origins and excludes page prices', async () => {
    const html = `<html><head>
<title>Meta Page</title>
<meta property="og:title" content="OG Title" />
<meta property="og:description" content="OG Desc" />
<meta property="og:image" content="https://img.example.com/og.jpg" />
<meta name="product:brand" content="Meta Brand" />
<meta property="product:price:amount" content="8.88" />
</head><body>
<div itemscope itemtype="https://schema.org/Product">
  <span itemprop="brand">MD Brand</span>
  <meta itemprop="price" content="8.88" />
  <img itemprop="image" src="https://img.example.com/md.jpg" />
</div>
</body></html>`;
    const result = await doStaticExtract(staticRequest(), {
      lookupFn: publicLookup,
      fetchFn: async () => htmlResponse(html),
    });
    expect(result.fieldProvenanceDetails).toEqual({
      title: { method: 'meta', sourcePath: 'meta:og:title' },
      brand: { method: 'microdata', sourcePath: 'microdata:Product.brand' },
      description: { method: 'meta', sourcePath: 'meta:og:description' },
      primaryImage: { method: 'meta', sourcePath: 'meta:og:image' },
    });
    expect(result.fieldProvenanceDetails).not.toHaveProperty('price');
    expect(result.data.price).toBeNull();
  });

  it('ignores page-price selectors and does not return third-party prices', async () => {
    const html = `<html><head><title>T</title></head><body>
<h1>Sel Title</h1>
<span class="brand">Sel Brand</span>
<div class="desc">Sel Desc</div>
<span class="price">$7.77</span>
<span class="flavor">Chicken</span>
<div class="gallery"><img src="https://img.example.com/sel.jpg" /></div>
</body></html>`;
    const result = await doStaticExtract(staticRequest({
      expected: { name: 'Sel Title', brandHint: null, spreadsheetHints: {} },
      profile: {
        runtime: 'static',
        selectors: {
          titleSelector: 'h1',
          brandSelector: '.brand',
          descriptionSelector: '.desc',
          priceSelector: '.price',
          imagesSelector: '.gallery img',
        },
        titleOptionalSelectors: [],
        customSelectors: { flavor: '.flavor' },
        imageRules: {},
        variantSelectionStrategy: null,
        allowedSourceDomains: ['brand.example.com'],
      },
    }), {
      lookupFn: publicLookup,
      fetchFn: async () => htmlResponse(html),
    });
    expect(result.fieldProvenanceDetails).toEqual({
      title: { method: 'profile_selector', sourcePath: 'h1' },
      brand: { method: 'profile_selector', sourcePath: '.brand' },
      description: { method: 'profile_selector', sourcePath: '.desc' },
      primaryImage: { method: 'profile_selector', sourcePath: '.gallery img' },
      'custom.flavor': { method: 'profile_selector', sourcePath: '.flavor' },
    });
    expect(result.fieldProvenanceDetails).not.toHaveProperty('price');
    expect(result.data.price).toBeNull();
  });
});

describe('guardedRouteHandler (rendered sub-resources + redirects pass through the guard)', () => {
  // Run one request through the single authoritative rendered-route handler
  // using the REAL profileNetworkGuard (SSRF floor + source-domain allowlist),
  // and record both the guard invocations and the route outcome.
  function runGuarded(url: string, allowlist: string[]) {
    const guardCalls: string[] = [];
    const routeCalls: string[] = [];
    const guard = async (u: string): Promise<boolean> => {
      guardCalls.push(u);
      return profileNetworkGuard(u, allowlist, { lookupFn: publicLookup });
    };
    const route = {
      request: () => ({ url: () => url }),
      continue: async () => { routeCalls.push('continue'); },
      abort: async (reason?: string) => { routeCalls.push(reason ?? 'abort'); },
    };
    return { guard, route, guardCalls, routeCalls };
  }

  it('routes an in-allowlist sub-resource through the guard and continues it', async () => {
    const { guard, route, guardCalls, routeCalls } = runGuarded('https://brand.example.com/img/product.jpg', ['brand.example.com']);
    await guardedRouteHandler(route, guard);
    expect(guardCalls).toEqual(['https://brand.example.com/img/product.jpg']);
    expect(routeCalls).toEqual(['continue']);
  });

  it('routes a sub-resource on a public domain outside the allowlist through the guard and aborts it', async () => {
    const { guard, route, guardCalls, routeCalls } = runGuarded('https://cdn.evil.example.com/img/product.jpg', ['brand.example.com']);
    await guardedRouteHandler(route, guard);
    expect(guardCalls).toEqual(['https://cdn.evil.example.com/img/product.jpg']);
    expect(routeCalls).toEqual(['blockedbyclient']);
  });

  it('routes a redirect hop to an in-allowlist destination through the guard and continues it', async () => {
    const { guard, route, guardCalls, routeCalls } = runGuarded('https://www.brand.example.com/p/1', ['brand.example.com']);
    await guardedRouteHandler(route, guard);
    expect(guardCalls).toEqual(['https://www.brand.example.com/p/1']);
    expect(routeCalls).toEqual(['continue']);
  });

  it('routes a redirect hop to a public domain outside the allowlist through the guard and aborts it', async () => {
    const { guard, route, guardCalls, routeCalls } = runGuarded('https://redirect.evil.example.com/x', ['brand.example.com']);
    await guardedRouteHandler(route, guard);
    expect(guardCalls).toEqual(['https://redirect.evil.example.com/x']);
    expect(routeCalls).toEqual(['blockedbyclient']);
  });

  it('aborts a tracker sub-resource even when it is on an in-allowlist domain', async () => {
    const { guard, route, guardCalls, routeCalls } = runGuarded('https://brand.example.com/analytics.js', ['brand.example.com']);
    await guardedRouteHandler(route, guard);
    expect(guardCalls).toEqual(['https://brand.example.com/analytics.js']);
    expect(routeCalls).toEqual(['blockedbyclient']);
  });

  it('aborts a private destination even when allowlisted (SSRF floor still applies)', async () => {
    const { guard, route, guardCalls, routeCalls } = runGuarded('https://10.0.0.5/p/1', ['10.0.0.5']);
    await guardedRouteHandler(route, guard);
    expect(guardCalls).toEqual(['https://10.0.0.5/p/1']);
    expect(routeCalls).toEqual(['blockedbyclient']);
  });
});

describe('buildGuardPreNavigationHooks (batch path installs the same authoritative guard)', () => {
  // Regression: runRenderedPages() used to accept per-input networkGuards but
  // install NO preNavigationHooks at all, so batch-path navigation, redirect
  // hops, and sub-resources bypassed profileNetworkGuard/allowedSourceDomains.
  // These tests drive the REAL hooks the batch runner passes to the crawler
  // with a fake page (same structural-fake pattern as the guardedRouteHandler
  // tests above) and the REAL profileNetworkGuard.

  function makeFakePage() {
    const routes: Array<{ pattern: string; handler: (route: GuardedRoute) => void | Promise<void> }> = [];
    const page: GuardedPage = {
      route: async (pattern, handler) => { routes.push({ pattern, handler }); },
    };
    return { page, routes };
  }

  function makeRoute(url: string) {
    const calls: string[] = [];
    const route: GuardedRoute = {
      request: () => ({ url: () => url }),
      continue: async () => { calls.push('continue'); },
      abort: async (reason?: string) => { calls.push(reason ?? 'abort'); },
    };
    return { route, calls };
  }

  it('routes a sub-resource and a redirect hop through the batch-path guard (allowed continue, out-of-allowlist deny)', async () => {
    const guardCalls: string[] = [];
    const guard = async (u: string): Promise<boolean> => {
      guardCalls.push(u);
      return profileNetworkGuard(u, ['brand.example.com'], { lookupFn: publicLookup });
    };
    const hooks = buildGuardPreNavigationHooks([
      { url: 'https://brand.example.com/p/1', networkGuard: guard },
    ]);
    expect(hooks).toHaveLength(1);

    const { page, routes } = makeFakePage();
    await hooks[0]({ page, request: { url: 'https://brand.example.com/p/1' } });
    expect(routes).toHaveLength(1);
    expect(routes[0].pattern).toBe('**/*');

    // Sub-resource on an in-allowlist domain → guard allows → continue
    const sub = makeRoute('https://brand.example.com/img/product.jpg');
    await routes[0].handler(sub.route);
    expect(sub.calls).toEqual(['continue']);

    // Redirect hop to a public domain outside the allowlist → guard denies → abort
    const redir = makeRoute('https://redirect.evil.example.com/x');
    await routes[0].handler(redir.route);
    expect(redir.calls).toEqual(['blockedbyclient']);

    // Every request was decided by the per-input guard — nothing bypassed it
    expect(guardCalls).toEqual([
      'https://brand.example.com/img/product.jpg',
      'https://redirect.evil.example.com/x',
    ]);
  });

  it('installs each input’s own guard (per-input isolation) and no route for unguarded inputs', async () => {
    const aCalls: string[] = [];
    const bCalls: string[] = [];
    const hooks = buildGuardPreNavigationHooks([
      { url: 'https://a.example.com/p', networkGuard: async (u) => { aCalls.push(u); return true; } },
      { url: 'https://b.example.com/p', networkGuard: async (u) => { bCalls.push(u); return false; } },
      { url: 'https://unguarded.example.com/p' },
    ]);
    expect(hooks).toHaveLength(1);

    const a = makeFakePage();
    await hooks[0]({ page: a.page, request: { url: 'https://a.example.com/p' } });
    const b = makeFakePage();
    await hooks[0]({ page: b.page, request: { url: 'https://b.example.com/p' } });
    const c = makeFakePage();
    await hooks[0]({ page: c.page, request: { url: 'https://unguarded.example.com/p' } });

    expect(a.routes).toHaveLength(1);
    expect(b.routes).toHaveLength(1);

    // Input A’s guard decides A’s requests (allowed → continue)
    const subA = makeRoute('https://a.example.com/img/x.jpg');
    await a.routes[0].handler(subA.route);
    expect(subA.calls).toEqual(['continue']);
    expect(aCalls).toEqual(['https://a.example.com/img/x.jpg']);

    // Input B’s guard decides B’s requests (denied → abort); A’s guard never sees it
    const subB = makeRoute('https://b.example.com/img/x.jpg');
    await b.routes[0].handler(subB.route);
    expect(subB.calls).toEqual(['blockedbyclient']);
    expect(bCalls).toEqual(['https://b.example.com/img/x.jpg']);
    expect(aCalls).not.toContain('https://b.example.com/img/x.jpg');

    // Unguarded input: no route installed at all (singular-path semantics)
    expect(c.routes).toHaveLength(0);
  });

  it('returns no hooks when no input declares a guard', () => {
    expect(buildGuardPreNavigationHooks([{ url: 'https://x.example.com/p' }])).toEqual([]);
  });
});
