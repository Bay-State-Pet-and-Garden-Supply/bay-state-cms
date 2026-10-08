/**
 * RED-capable collector-seam tests (diagnosing-bugs Phase 1).
 *
 * Exercises the ACTUAL page extractor (`candidateFromPageHtml`, the pure
 * parser `collectPage` delegates to after fetching) with inline public HTML
 * fixtures on a reserved fake manufacturer domain. No CLI fetching, no
 * network, no DB, no private custody rows, no gold.
 *
 * Contaminant titles mirror the actual first public v3 bank defects
 * (taxonomy nav, product-line listings, ingredient glossary, cookie/privacy
 * footer clips) — public-only knowledge, no private reads.
 */
import { describe, it, expect } from 'bun:test';
import { hashCanonicalJson } from '../../shared/stable-id';
import {
  candidateFromPageHtml,
  canonicalProductUrlKey,
  deriveAuthorityHash,
  findExistingArtifacts,
  isAllowedSourceUrl,
  isExcludedProductUrl,
  loadPublicExclusion,
  normalizeDeniedHost,
  parseSeedFile,
  partitionFeedRows,
  sameProductUrl,
  selectFetchUrls,
  type Candidate,
  type Seed,
} from '../../../scripts/collect-jev-v3-sources';
import { parseInvocationCap, SOURCE_WINDOW_MAX } from '../../../scripts/lib/source-request-window';

const SEED: Seed = {
  domain: 'fixtures.test',
  brand: 'Fixture Brand',
  stratum: 'food',
  sourceRule: 'inline test fixture',
};

const RETRIEVED_AT = '2026-10-05T12:00:00.000Z';

function extract(url: string, html: string) {
  return candidateFromPageHtml(SEED, url, url, html, RETRIEVED_AT, {});
}

// Manufacturer NAV/taxonomy page, not a product family.
const NAV_TAXONOMY_HTML = `<!doctype html><html><head><title>Dog Food Types | Fixture Brand</title></head>
<body><nav><ul><li><a href="/dog-food-types/dry">Dry Dog Food</a></li>
<li><a href="/dog-food-types/wet">Wet Dog Food</a></li>
<li><a href="/dog-food-types/treats">Dog Treats and Chews for Training</a></li></ul></nav>
<main><h1>Dog Food Types</h1>
<p>Browse every kind of nutrition we make for dogs of all breeds, sizes and life stages.</p>
<p>Use the menu above to explore dry food, wet food, toppers, treats and supplements.</p></main>
<div class="cookie-banner"><p>We use cookies to remember your preferences and improve your browsing experience every single day.</p></div>
<footer><p>Copyright 2026 Fixture Brand Incorporated all rights reserved worldwide and everywhere else.</p></footer>
</body></html>`;

// Product-line listing + FAQ page, not a single product family.
const LINE_LISTING_HTML = `<!doctype html><html><head><title>Dog Product Lines | Fixture Brand</title></head>
<body><main><h1>Dog Product Lines</h1>
<p>Our complete lineup of balanced recipes for puppies, adults and senior dogs of every size.</p>
<ul><li>Original Recipe dry food for adult dogs</li><li>High Protein wet food with real salmon</li>
<li>Grain Free treats for sensitive stomachs</li></ul>
<section><h2>Frequently asked questions</h2>
<p>Which line is right for my puppy and how much should I feed a large senior dog?</p></section></main>
<div class="cookie-banner"><p>We use cookies to remember your preferences and improve your browsing experience every single day.</p></div>
<footer><p>Copyright 2026 Fixture Brand Incorporated all rights reserved worldwide and everywhere else.</p></footer>
</body></html>`;

// Ingredient glossary page, not a product family.
const INGREDIENT_HTML = `<!doctype html><html><head><title>Chicken Meal | Fixture Brand Ingredients</title></head>
<body><main><h1>Chicken Meal</h1>
<p>Chicken meal is a concentrated protein ingredient rendered from clean chicken flesh and skin.</p>
<p>It supplies essential amino acids that support strong muscles in active adult dogs.</p></main>
<div class="cookie-banner"><p>We use cookies to remember your preferences and improve your browsing experience every single day.</p></div>
<footer><p>Copyright 2026 Fixture Brand Incorporated all rights reserved worldwide and everywhere else.</p></footer>
</body></html>`;

// Cookie/privacy-only page, not a product family.
const COOKIE_HTML = `<!doctype html><html><head><title>Privacy Policy | Fixture Brand</title></head>
<body><main><h1>Privacy Policy</h1>
<p>We use cookies to remember your preferences and improve your browsing experience every single day of the year.</p>
<p>You can disable cookies in your browser settings, though some features may stop working correctly afterwards.</p></main>
<footer><p>Copyright 2026 Fixture Brand Incorporated all rights reserved worldwide and everywhere else.</p></footer>
</body></html>`;

// Genuine single-product page: JSON-LD Product + DOM product description.
const VALID_PRODUCT_HTML = `<!doctype html><html><head><title>Salmon Recipe Dry Dog Food | Fixture Brand</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product",
"name":"Fixture Brand Salmon Recipe Dry Dog Food 25 lb",
"brand":{"@type":"Brand","name":"Fixture Brand"},
"description":"Complete and balanced dry dog food with real salmon as the first ingredient."}</script>
</head>
<body><main><h1>Fixture Brand Salmon Recipe Dry Dog Food 25 lb</h1>
<div class="product-description">
<p>Complete and balanced dry dog food with real salmon as the first ingredient for adult dogs.</p>
<p>Kibble size is formulated for medium and large breeds and the 25 lb resealable bag keeps food fresh.</p>
</div></main>
<div class="cookie-banner"><p>We use cookies to remember your preferences and improve your browsing experience every single day.</p></div>
<footer><p>Copyright 2026 Fixture Brand Incorporated all rights reserved worldwide and everywhere else.</p></footer>
</body></html>`;

describe('jev v3 source extractor (collector seam)', () => {
  it('rejects a manufacturer NAV/taxonomy page as a product candidate', () => {
    expect(extract('https://fixtures.test/dog-product-types', NAV_TAXONOMY_HTML)).toBeNull();
  });

  it('rejects a product-line listing/FAQ page as a product candidate', () => {
    expect(extract('https://fixtures.test/dog-product-lines', LINE_LISTING_HTML)).toBeNull();
  });

  it('rejects an ingredient glossary page as a product candidate', () => {
    expect(extract('https://fixtures.test/ingredients/chicken-meal', INGREDIENT_HTML)).toBeNull();
  });

  it('rejects a cookie/privacy-only page as a product candidate', () => {
    expect(extract('https://fixtures.test/privacy', COOKIE_HTML)).toBeNull();
  });

  it('accepts a genuine single-product page and retains literal defining features, not cookie/footer text', () => {
    const candidate = extract('https://fixtures.test/products/salmon-recipe', VALID_PRODUCT_HTML);
    expect(candidate).not.toBeNull();
    const excerpts = candidate!.row.excerpts as Array<{ text: string }>;
    const text = excerpts.map(e => e.text).join(' ');
    expect(text).toContain('real salmon as the first ingredient');
    expect(text).not.toContain('cookies');
    expect(text).not.toContain('Copyright');
  });

  it('accepts Sitecore-cased schema.org keys (Name/Description) as the same vocabulary', () => {
    const html = VALID_PRODUCT_HTML
      .replace('"name":"Fixture Brand Salmon Recipe Dry Dog Food 25 lb"', '"Name":"Fixture Brand Salmon Recipe Dry Dog Food 25 lb"')
      .replace('"description":"Complete and balanced dry dog food with real salmon as the first ingredient."', '"Description":"Complete and balanced dry dog food with real salmon as the first ingredient."');
    const candidate = extract('https://fixtures.test/products/salmon-recipe', html);
    expect(candidate).not.toBeNull();
    const excerpts = candidate!.row.excerpts as Array<{ text: string }>;
    expect(excerpts.map(e => e.text).join(' ')).toContain('real salmon as the first ingredient');
  });
});

describe('jev v3 collector guards (pure, no network)', () => {
  it('parseInvocationCap defaults to remaining window, rejects NaN/negative/zero/fractional/over-cap/over-remaining', () => {
    expect(SOURCE_WINDOW_MAX).toBe(1200);
    expect(parseInvocationCap(null, 1200)).toBe(1200);
    expect(parseInvocationCap(null, 37)).toBe(37);
    expect(parseInvocationCap('100', 1200)).toBe(100);
    for (const bad of ['0', '-5', '1.5', 'abc', '', 'NaN', '1201', '1000000', '10e2']) {
      expect(() => parseInvocationCap(bad, 1200), `"${bad}"`).toThrow(/invalid_attempt_cap/);
    }
    expect(() => parseInvocationCap('38', 37)).toThrow(/exceeds remaining window/);
    expect(() => parseInvocationCap(null, 0)).toThrow(/source_window_exhausted/);
  });

  it('normalizeDeniedHost collapses apex/www and case so a denial sticks across hops', () => {
    expect(normalizeDeniedHost('www.fixtures.test')).toBe('fixtures.test');
    expect(normalizeDeniedHost('fixtures.test')).toBe('fixtures.test');
    expect(normalizeDeniedHost('WWW.Fixtures.TEST')).toBe('fixtures.test');
  });

  it('isAllowedSourceUrl enforces the shared public-source policy', () => {
    expect(isAllowedSourceUrl('https://acme-pet-foods.com/products/salmon-recipe')).toBe(true);
    expect(isAllowedSourceUrl('http://acme-pet-foods.com/products/salmon-recipe')).toBe(false);
    expect(isAllowedSourceUrl('https://user:pass@acme-pet-foods.com/products/x')).toBe(false);
    expect(isAllowedSourceUrl('https://acme-pet-foods.com/products/x?token=secret')).toBe(false);
    expect(isAllowedSourceUrl('https://192.168.1.10/products/x')).toBe(false);
    expect(isAllowedSourceUrl('https://localhost/products/x')).toBe(false);
    expect(isAllowedSourceUrl('not a url')).toBe(false);
  });

  it('findExistingArtifacts reports sealed paths before any network', () => {
    const exists = (p: string): boolean => p.endsWith('holdout-inputs.json') || p.endsWith('source-development.json');
    const found = findExistingArtifacts('/custody', '/public', exists);
    expect(found).toEqual(['/custody/holdout-inputs.json', '/public/source-development.json']);
    expect(findExistingArtifacts('/custody', '/public', () => false)).toEqual([]);
  });

  it('findExistingArtifacts covers the new window receipts, not the removed cumulative ledger', () => {
    const exists = (p: string): boolean =>
      p.endsWith('source-window-usage.json') || p.endsWith('source-request-receipts.json') || p.endsWith('cumulative-source-ledger.json');
    expect(findExistingArtifacts('/custody', '/public', exists)).toEqual([
      '/custody/source-window-usage.json',
      '/public/source-request-receipts.json',
    ]);
  });

  it('loadPublicExclusion rejects private-looking or missing stage banks without reading custody', () => {
    for (const bad of ['stage/holdout-inputs.json', 'stage/membership.json', 'some-custody-bank.json']) {
      expect(() => loadPublicExclusion([bad])).toThrow(/private_exclusion_rejected/);
    }
    expect(() => loadPublicExclusion(['does/not/exist-bank.json'])).toThrow(/missing_stage_bank/);
  });

  it('deriveAuthorityHash is canonical (key-order stable) and rejects non-taxonomy input', () => {
    const a = deriveAuthorityHash({ bundle: { b: 1, a: 2 }, pages: [], binding: { release: 'test-release' } });
    const b = deriveAuthorityHash({ binding: { release: 'test-release' }, pages: [], bundle: { a: 2, b: 1 } });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    for (const bad of [null, 42, 'x', [], {}, { pages: [] }]) {
      expect(() => deriveAuthorityHash(bad)).toThrow(/invalid_taxonomy/);
    }
  });

  it('uses the preparation/replay authority domain and excludes observation time', () => {
    const bundle = { productTypes: [{ id: 'example', name: 'Example' }] };
    const pages = [{ pageId: 'page-1', pageName: 'Example' }];
    const binding = { release: 'test-release', capturedAt: '2026-10-05T00:00:00.000Z' };
    const expected = hashCanonicalJson({ bundle, pages, binding: { release: 'test-release' } });
    expect(deriveAuthorityHash({ bundle, pages, binding })).toBe(expected);
    expect(deriveAuthorityHash({ bundle, pages, binding: { ...binding, capturedAt: '2026-10-06T00:00:00.000Z' } })).toBe(expected);
  });

  it('sameProductUrl matches apex/www and trailing slashes, not different paths', () => {
    expect(sameProductUrl('https://fixtures.test/products/x', 'https://www.fixtures.test/products/x')).toBe(true);
    expect(sameProductUrl('https://fixtures.test/products/x/', 'https://fixtures.test/products/x')).toBe(true);
    expect(sameProductUrl('https://fixtures.test/products/x', 'https://fixtures.test/products/y')).toBe(false);
    expect(sameProductUrl('https://fixtures.test/products/x', 'https://other.test/products/x')).toBe(false);
  });

  it('partitionFeedRows admits only sitemap-matched canonicals; the rest are withheld', () => {
    const row = (canonicalUrl: string): Candidate => ({
      row: { canonicalUrl },
      stratum: 'food',
      sourceForm: 'manufacturer-feed',
    });
    const feed = [
      row('https://fixtures.test/products/matched'),
      row('https://fixtures.test/products/unmatched'),
    ];
    const { verified, unverified } = partitionFeedRows(feed, ['https://www.fixtures.test/products/matched']);
    expect(verified.map(c => String(c.row.canonicalUrl))).toEqual(['https://fixtures.test/products/matched']);
    expect(unverified.map(c => String(c.row.canonicalUrl))).toEqual(['https://fixtures.test/products/unmatched']);
    expect(partitionFeedRows(feed, []).verified).toEqual([]);
  });

  it('selectFetchUrls keeps product URLs, rejects nav/FAQ/ingredient/cookie/policy URLs, caps and dedupes', () => {
    const urls = [
      'https://fixtures.test/products/salmon-recipe',
      'https://fixtures.test/products/salmon-recipe',
      'https://fixtures.test/dog-product-types',
      'https://fixtures.test/ingredients/chicken-meal',
      'https://fixtures.test/learn/faq',
      'https://fixtures.test/blog/news',
      'https://fixtures.test/privacy',
      'https://fixtures.test/cart',
    ];
    expect(selectFetchUrls(urls, 10)).toEqual(['https://fixtures.test/products/salmon-recipe']);
    expect(selectFetchUrls(urls, 0)).toEqual([]);
    expect(selectFetchUrls(['https://fixtures.test/about'], 10)).toEqual([]);
  });

  it('selectFetchUrls admits category-harvested prequalified URLs past the score floor (proof still applies downstream)', () => {
    // BigCommerce-style flat slugs score below the /products/ floor but are
    // qualified by category-listing context; the JSON-LD identity proof in
    // collectPage still rejects non-products.
    const flat = 'https://fixtures.test/kong-classic';
    expect(selectFetchUrls([flat], 10)).toEqual([]);
    expect(selectFetchUrls([flat], 10, new Set([flat]))).toEqual([flat]);
    expect(selectFetchUrls([flat, 'https://fixtures.test/about'], 10, new Set([flat]))).toEqual([flat]);
  });

  it('parseSeedFile accepts validated domain-only seeds and rejects URLs/duplicates/overflow', () => {
    const good: Seed[] = [
      { domain: 'acme-pet-foods.com', brand: 'Acme', stratum: 'toys', sourceRule: 'sitemap + pages' },
    ];
    expect(parseSeedFile(good)).toEqual(good);
    for (const bad of [
      [],
      [{ domain: 'https://acme-pet-foods.com/products/x', brand: 'Acme', stratum: 'toys', sourceRule: 'sitemap' }],
      [{ domain: 'acme-pet-foods.com', brand: '', stratum: 'toys', sourceRule: 'sitemap' }],
      [{ domain: 'acme-pet-foods.com', brand: 'Acme', stratum: 'unknown', sourceRule: 'sitemap' }],
      [
        { domain: 'acme-pet-foods.com', brand: 'Acme', stratum: 'toys', sourceRule: 'sitemap' },
        { domain: 'ACME-PET-FOODS.COM', brand: 'Acme', stratum: 'toys', sourceRule: 'sitemap' },
      ],
      Array.from({ length: 25 }, (_, i) => ({ domain: `brand${i}.com`, brand: 'B', stratum: 'toys', sourceRule: 'sitemap' })),
    ]) {
      expect(() => parseSeedFile(bad)).toThrow();
    }
  });
});

describe('jev v3 prior-source exclusion (canonical identity, no network)', () => {
  // The sealed spelling carries a changed SKU: the exclusion must key on
  // product-URL identity (apex/www + trailing slash), never the SKU or the
  // raw string, and the gate must fire BEFORE any fetch.
  const sealed = 'https://fixtures.test/products/salmon-recipe';
  const exclusion = {
    byFamily: new Set<string>(),
    byUrl: new Set([canonicalProductUrlKey(sealed) as string]),
  };

  it('canonicalProductUrlKey collapses apex/www and trailing-slash spellings to one identity', () => {
    expect(canonicalProductUrlKey('https://www.fixtures.test/products/salmon-recipe/')).toBe(
      canonicalProductUrlKey(sealed),
    );
    expect(canonicalProductUrlKey('https://fixtures.test/products/other')).not.toBe(
      canonicalProductUrlKey(sealed),
    );
    expect(canonicalProductUrlKey('not a url')).toBeNull();
  });

  it('excludes a sealed product under any URL spelling before fetch, while a genuinely different path stays fetchable', () => {
    for (const spelling of [
      'https://fixtures.test/products/salmon-recipe',
      'https://www.fixtures.test/products/salmon-recipe',
      'https://fixtures.test/products/salmon-recipe/',
      'https://www.fixtures.test/products/salmon-recipe/',
    ]) {
      expect(isExcludedProductUrl(spelling, exclusion)).toBe(true);
    }
    expect(isExcludedProductUrl('https://fixtures.test/products/tuna-recipe', exclusion)).toBe(false);
    expect(isExcludedProductUrl('https://other.test/products/salmon-recipe', exclusion)).toBe(false);
  });
});
