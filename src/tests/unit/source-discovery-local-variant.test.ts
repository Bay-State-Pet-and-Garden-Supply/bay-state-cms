import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('bun:sqlite', () => ({ Database: class MockDb { constructor() {} exec() {} query() { return { get: () => undefined, all: () => [], run: () => {} } as any; } } }));

// Mock db dependencies so discoverSources short-circuits via localCandidates
vi.mock('@/db/repositories/brand-site-repo', () => ({
  findBrandSites: vi.fn(() => [{ domain: 'betterbone.com' }]),
}));
vi.mock('@/db/repositories/brand-url-index-repo', () => ({
  getActiveUrlsForDomain: vi.fn(() => ['https://betterbone.com/products/the-betterbone-beef']),
  normalizeDomain: (d: string) => d,
  reconcileSitemapUrls: vi.fn(),
}));
vi.mock('@/db/repositories/sitemap-telemetry-repo', () => ({
  recordDiscoveryEvent: vi.fn(),
}));
vi.mock('@/db/repositories/extractor-profile-repo', () => ({
  findProfileByDomain: vi.fn(() => null),
}));
vi.mock('@/db/repositories/sitemap-cache-repo', () => ({
  getCachedSitemapUrls: vi.fn(() => null),
  insertSitemapCache: vi.fn(),
}));
vi.mock('@/onboarding/local-brand-url-finder', () => ({
  findLocalBrandCandidates: vi.fn(async () => [
    { url: 'https://betterbone.com/products/the-betterbone-beef', title: 'BetterBone', confidence: 0.92, matchType: 'upc_exact', sourceMethod: 'local_upc' as const },
  ]),
}));

import { discoverSources } from '../../onboarding/source-discovery';
import { overrideVariantFlags, resetVariantFlagsOverride } from '../../onboarding/variant-flags';

const SHOPIFY_HTML = `<html><head><script>window.productJSON=${JSON.stringify({ id:1,title:'BetterBone',options:[{name:'Size'}],variants:[{id:4123456001,title:'SM',option1:'Small',sku:'BB-SM',barcode:'810001234501',price:1299,available:true},{id:4123456002,title:'LG',option1:'Large',sku:'BB-LG',barcode:'810001234502',price:1499,available:true}],images:[]}) };</script></head><body></body></html>`;

describe('source-discovery local short-circuit variantResolution', () => {
  let origFetch: typeof fetch;
  beforeEach(() => { origFetch = globalThis.fetch; overrideVariantFlags({ mode: 'active' }); globalThis.fetch = vi.fn(async (url: any, init: any) => {
    const u = String(url);
    // HEAD validation for local candidate
    if (init?.method === 'HEAD' || init?.method === 'GET') {
      if (u.includes('betterbone.com/products/the-betterbone-beef')) return new Response(SHOPIFY_HTML, { status: 200, headers: { 'content-type': 'text/html' } }) as any;
    }
    // variant resolver fetch
    if (u.includes('betterbone.com/products/the-betterbone-beef')) return new Response(SHOPIFY_HTML, { status: 200, headers: { 'content-type': 'text/html' } }) as any;
    return new Response('', { status: 404 }) as any;
  }) as any; });
  afterEach(() => { globalThis.fetch = origFetch; resetVariantFlagsOverride(); vi.restoreAllMocks(); });

  it('local high-confidence short-circuit still reports variantResolution', async () => {
    const res = await discoverSources('810001234501', 'BetterBone Hard Beef Small', 'BetterBone', { price: 12.99, networkFetch: globalThis.fetch as any });
    expect(res.candidates.length).toBeGreaterThan(0);
    // Must include variantResolution even on local short-circuit
    expect(res.variantResolution).toBeDefined();
    expect(res.variantResolution).not.toBeNull();
    if (res.variantResolution) {
      expect(typeof res.variantResolution.status).toBe('string');
      expect(Array.isArray(res.variantResolution.warnings)).toBe(true);
    }
  });
});
