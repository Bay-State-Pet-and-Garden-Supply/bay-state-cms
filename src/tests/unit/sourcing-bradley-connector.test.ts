import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BradleyConnector, parseBradleyPdp, parseBradleySearchCandidates } from '../../onboarding/sourcing/connectors/bradley';
import type { SourcingLookupRequest } from '../../onboarding/sourcing/contracts';
import type { ScraperFetchPage, ScraperFetchPageResult } from '../../onboarding/sourcing/html-scraper/contracts';

const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'sourcing', 'html-scrapers', 'bradley');
const FIXTURES: Record<string, string> = {};
for (const name of ['found-search.html', 'found-pdp.html', 'not-found.html', 'unexpected-markup.html']) {
  FIXTURES[name] = readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

const SEARCH = 'https://www.bradleycaldwell.com/search?term=';
const PDP = 'https://www.bradleycaldwell.com/e-z-hang-scale-silver-up-to-55-lb-001135';

/** Deterministic fake fetcher: URL → fixture. Records every call for assertions. */
function makeFetcher(overrides: Record<string, ScraperFetchPageResult> = {}) {
  const calls: Array<{ url: string; browserRequired?: boolean }> = [];
  const fetchPage: ScraperFetchPage = async (url, opts) => {
    calls.push({ url, browserRequired: opts.browserRequired });
    const hit = overrides[url];
    if (hit) return hit;
    if (url.startsWith(SEARCH + '018653299524')) {
      return { ok: true, html: FIXTURES['found-search.html'], finalUrl: url };
    }
    if (url.startsWith(SEARCH + '018653299520')) {
      return { ok: true, html: FIXTURES['found-search.html'], finalUrl: url };
    }
    if (url.startsWith(SEARCH + '000000000000')) {
      return { ok: true, html: FIXTURES['not-found.html'], finalUrl: url };
    }
    if (url.startsWith(SEARCH)) {
      return { ok: true, html: FIXTURES['unexpected-markup.html'], finalUrl: url };
    }
    if (url === PDP) {
      return { ok: true, html: FIXTURES['found-pdp.html'], finalUrl: url };
    }
    return { ok: false, code: 'unexpected', message: `no fixture for ${url}` };
  };
  return { fetchPage, calls };
}

function makeRequest(upc: string, extra: Partial<SourcingLookupRequest> = {}): SourcingLookupRequest {
  const controller = new AbortController();
  return {
    itemId: 'item-1',
    generationId: 'gen-1',
    upc,
    gtin: null,
    brandHint: null,
    registerName: null,
    connection: { id: 'conn-bradley', distributorId: 'bradley', connectorType: 'html_scraper', configuration: {} },
    secret: null,
    signal: controller.signal,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    ...extra,
  };
}

describe('BradleyConnector — found (exact UPC match)', () => {
  test('returns a merchandising-depth record with exact identity', async () => {
    const { fetchPage } = makeFetcher();
    const connector = new BradleyConnector({ fetchPage, now: () => '2026-08-15T00:00:00.000Z' });
    const result = await connector.lookupByGtin(makeRequest('018653299524'));

    expect(result.outcome).toBe('found');
    if (result.outcome !== 'found') return;
    const { record, matchedFields } = result;
    expect(record.matchedIdentifier).toBe('018653299524');
    expect(record.name).toBe('E-Z HANG SCALE');
    expect(record.brand).toBe('KERBL');
    expect(record.distributorSku).toBe('001135');
    expect(record.manufacturerPartNumber).toBe('099917');
    expect(record.weight).toBe('3.1 lb');
    expect(record.attributes.size).toBe('UP TO 55 LB');
    expect(record.attributes.packCount).toBe('6');
    expect(record.casePack).toBe('6');
    expect(record.unitOfMeasure).toBe('EA');
    expect(record.description).toMatch(/^For quick weight control, for economic forage control/);
    expect(record.ingredients).toMatch(/^nickel-plated/);
    expect(record.sourceUrl).toBe(PDP);
    expect(record.observedAt).toBe('2026-08-15T00:00:00.000Z');
    expect(matchedFields).toEqual(expect.arrayContaining(['matchedIdentifier', 'name', 'brand', 'distributorSku', 'manufacturerPartNumber', 'weight', 'size', 'packCount', 'casePack', 'unitOfMeasure', 'description', 'ingredients', 'sourceUrl']));
  });

  test('images are HTTPS display-only candidates on the BigCommerce asset host only', async () => {
    const { fetchPage } = makeFetcher();
    const connector = new BradleyConnector({ fetchPage });
    const result = await connector.lookupByGtin(makeRequest('018653299524'));
    if (result.outcome !== 'found') throw new Error('expected found');
    expect(result.record.imageUrls.length).toBeGreaterThan(0);
    for (const url of result.record.imageUrls) {
      expect(url.startsWith('https://')).toBe(true);
      expect(new URL(url).hostname).toMatch(/bigcommerce\.com|bradleycaldwell\.com$/);
      expect(url).toMatch(/001135/); // product's own gallery images only — never recommendation cards
    }
  });

  test('public connector: requiresSecret=false and a null secret is ignored', async () => {
    const connector = new BradleyConnector({});
    expect(connector.connectorType).toBe('html_scraper');
    expect(connector.providerId).toBe('bradley');
    expect(connector.requiresSecret).toBe(false);
    const { fetchPage } = makeFetcher();
    const result = await new BradleyConnector({ fetchPage }).lookupByGtin(makeRequest('018653299524'));
    expect(result.outcome).toBe('found');
  });
});

describe('BradleyConnector — fail-closed outcomes', () => {
  test('explicit no-result page → not_stocked:no_exact_match (no browser fallback)', async () => {
    const { fetchPage, calls } = makeFetcher();
    const result = await new BradleyConnector({ fetchPage }).lookupByGtin(makeRequest('000000000000'));
    expect(result.outcome).toBe('not_stocked');
    if (result.outcome === 'not_stocked') expect(result.reason).toContain('no exact match');
    // The real (large) no-result page must NOT trigger the browser fallback.
    expect(calls.some((c) => c.browserRequired)).toBe(false);
  });

  test('valid page whose UPC differs from the lookup identifier → not_stocked:wrong_variant', async () => {
    const { fetchPage } = makeFetcher();
    const result = await new BradleyConnector({ fetchPage }).lookupByGtin(makeRequest('018653299520'));
    expect(result.outcome).toBe('not_stocked');
    if (result.outcome === 'not_stocked') expect(result.reason).toContain('wrong variant');
  });

  test('tiny static shell triggers EXACTLY ONE browser fallback then source_error:unexpected_markup', async () => {
    const { fetchPage, calls } = makeFetcher();
    const result = await new BradleyConnector({ fetchPage }).lookupByGtin(makeRequest('999999999999'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('unexpected_markup');
    const browserCalls = calls.filter((c) => c.browserRequired);
    expect(browserCalls.length).toBe(1); // exactly one browser fallback — never unbounded
  });

  test('transport failure on search → source_error with the stable code', async () => {
    const { fetchPage } = makeFetcher({ [SEARCH + '018653299524']: { ok: false, code: 'timeout', message: 'transport timed out' } });
    const result = await new BradleyConnector({ fetchPage }).lookupByGtin(makeRequest('018653299524'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('timeout');
  });

  test('pre-aborted signal → source_error:cancelled without any fetch', async () => {
    const { fetchPage, calls } = makeFetcher();
    const controller = new AbortController();
    controller.abort();
    const result = await new BradleyConnector({ fetchPage }).lookupByGtin(makeRequest('018653299524', { signal: controller.signal }));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('cancelled');
    expect(calls.length).toBe(0);
  });

  test('no 8-14 digit identifier → source_error:no_identifier (001135 stays parser-only)', async () => {
    const { fetchPage, calls } = makeFetcher();
    const result = await new BradleyConnector({ fetchPage }).lookupByGtin(makeRequest('001135'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('no_identifier');
    expect(calls.length).toBe(0);
  });

  test('invalid connection configuration fails closed as config_invalid', async () => {
    const { fetchPage } = makeFetcher();
    const connector = new BradleyConnector({ fetchPage });
    const result = await connector.lookupByGtin(
      makeRequest('018653299524', { connection: { id: 'c', distributorId: 'bradley', connectorType: 'html_scraper', configuration: { evilSelector: '#x' } } }),
    );
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('config_invalid');
  });

  test('no price/inventory/stock/pallet data ever enters the record', async () => {
    const { fetchPage } = makeFetcher();
    const result = await new BradleyConnector({ fetchPage }).lookupByGtin(makeRequest('018653299524'));
    if (result.outcome !== 'found') throw new Error('expected found');
    const flat = JSON.stringify(result.record);
    for (const forbidden of ['price', 'inventory', 'stock', 'pallet', 'availability', 'FOB', 'Country']) {
      expect(flat.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(result.record.features).toEqual([]);
  });
});

describe('Bradley pure parsers (fixture-based)', () => {
  test('parseBradleySearchCandidates extracts only product-slug links', () => {
    const candidates = parseBradleySearchCandidates(FIXTURES['found-search.html']);
    expect(candidates).toEqual([PDP]);
  });

  test('no-result page yields zero candidates', () => {
    expect(parseBradleySearchCandidates(FIXTURES['not-found.html'])).toEqual([]);
  });

  test('parseBradleyPdp extracts the full recovered field map', () => {
    const pdp = parseBradleyPdp(FIXTURES['found-pdp.html']);
    expect(pdp.parsed).toBe(true);
    expect(pdp.upc).toBe('018653299524');
    expect(pdp.name).toBe('E-Z HANG SCALE');
    expect(pdp.brand).toBe('KERBL');
    expect(pdp.distributorSku).toBe('001135');
    expect(pdp.mpn).toBe('099917');
    expect(pdp.weight).toBe('3.1 lb');
    expect(pdp.size).toBe('UP TO 55 LB');
    expect(pdp.casePack).toBe('6');
    expect(pdp.unitOfMeasure).toBe('EA');
    expect(pdp.description).toMatch(/^For quick weight control/);
    expect(pdp.ingredients).toMatch(/^nickel-plated/);
    expect(pdp.images.length).toBeGreaterThan(0);
    expect(pdp.images.every((u) => /001135/.test(u))).toBe(true);
  });

  test('unexpected shell parses as not-a-PDP', () => {
    const pdp = parseBradleyPdp(FIXTURES['unexpected-markup.html']);
    expect(pdp.parsed).toBe(false);
  });
});

describe('Bradley brand candidates (issue #110)', () => {
  const BASE = (body: string) => `<html><body>${body}</body></html>`;
  const H1 = `<h1>E-Z HANG SCALE</h1>`;

  test('adjacent brand link wins with provenance', () => {
    const p = parseBradleyPdp(BASE(`<p><a href="/kerbl">KERBL</a></p>${H1}`));
    expect(p.brand).toBe('KERBL');
    expect(p.brandSource).toBe('adjacent_link');
  });

  test('existing PDP fixture resolves via the adjacent link', () => {
    const p = parseBradleyPdp(FIXTURES['found-pdp.html']);
    expect(p.brand).toBe('KERBL');
    expect(p.brandSource).toBe('adjacent_link');
  });

  test('brand absent everywhere yields observed-null (held downstream, never guessed)', () => {
    const p = parseBradleyPdp(BASE(H1));
    expect(p.brand).toBeNull();
    expect(p.brandSource).toBeNull();
  });

  test('brand moved into the spec list resolves with spec provenance', () => {
    const p = parseBradleyPdp(BASE(`${H1}<dl>
      <dt><strong>Brand</strong></dt><dd>SALTER</dd>
      <dt><strong>UPC</strong></dt><dd>018653299524</dd>
    </dl>`));
    expect(p.brand).toBe('SALTER');
    expect(p.brandSource).toBe('spec');
  });

  test('Manufacturer spec label is a brand candidate', () => {
    const p = parseBradleyPdp(BASE(`${H1}<dl>
      <dt><strong>Manufacturer</strong></dt><dd>ACME CO</dd>
    </dl>`));
    expect(p.brand).toBe('ACME CO');
    expect(p.brandSource).toBe('spec');
  });

  test('JSON-LD vendor brand resolves with json_ld provenance', () => {
    const p = parseBradleyPdp(BASE(`${H1}<script type="application/ld+json">
      {"@type":"Product","name":"E-Z HANG SCALE","brand":{"@type":"Brand","name":"Kerbl"}}
    </script>`));
    expect(p.brand).toBe('Kerbl');
    expect(p.brandSource).toBe('json_ld');
  });

  test('adjacent link outranks spec and JSON-LD (first-nonempty wins)', () => {
    const p = parseBradleyPdp(BASE(`<p><a href="/kerbl">KERBL</a></p>${H1}<dl>
      <dt><strong>Brand</strong></dt><dd>WRONG</dd>
    </dl><script type="application/ld+json">{"brand":"ALSOWRONG"}</script>`));
    expect(p.brand).toBe('KERBL');
    expect(p.brandSource).toBe('adjacent_link');
  });

  test('malformed JSON-LD never throws and falls through to null', () => {
    const p = parseBradleyPdp(BASE(`${H1}<script type="application/ld+json">not json {{{</script>`));
    expect(p.brand).toBeNull();
    expect(p.brandSource).toBeNull();
    expect(p.parsed).toBe(true);
  });
});

describe('Bradley live-shape extraction (inline HTML mirroring the 2026-08-15 captured PDP)', () => {
  // Live-shaped PDP: h1 + preceding brand paragraph, dt/dd spec list (incl.
  // the excluded Pallet Quantity + Type), Additional Details li list (incl.
  // the excluded Country + FOB Code), description prose, breadcrumb nav, and
  // a recommendation-card image whose URL lacks the product SKU.
  const LIVE_PDP = `
    <html><body>
      <p><a href="/kerbl">KERBL</a></p>
      <h1 class="mb-3 mt-2">E-Z HANG SCALE</h1>
      <dl>
        <dt class="mt-0"><strong>BCI Item Number</strong></dt><dd class="mt-0 pl-0">001135</dd>
        <dt class="mt-0"><strong>Manufacturer #</strong></dt><dd class="mt-0 pl-0">099917</dd>
        <dt class="mt-0"><strong>Size</strong></dt><dd class="mt-0 pl-0">UP TO 55 LB</dd>
        <dt class="mt-0"><strong>UPC</strong></dt><dd class="mt-0 pl-0">018653299524</dd>
        <dt class="mt-0"><strong>Unit of Measure</strong></dt><dd class="mt-0 pl-0">EA</dd>
        <dt class="mt-0"><strong>Case Pack</strong></dt><dd class="mt-0 pl-0">6</dd>
        <dt class="mt-0"><strong>Pallet Quantity</strong></dt><dd class="mt-0 pl-0">144</dd>
        <dt class="mt-0"><strong>Type</strong></dt><dd class="mt-0 pl-0">SILVER</dd>
      </dl>
      <div class="prose">
        <h2>Description</h2>
        <p>For quick weight control, for economic forage control of horses and ponies. Nickel-plated hooks attach quickly.</p>
      </div>
      <h2>Additional Details</h2>
      <ul class="list-disc space-y-1">
        <li>Country: CHINA</li>
        <li>Weight: 3.1 lb</li>
        <li>FOB Code: N</li>
        <li>Ingredients: nickel-plated hooks</li>
      </ul>
      <nav aria-label="breadcrumb"><ol>
        <li><a href="/">Home</a></li><li><a href="/kerbl">KERBL</a></li><li><a href="/e-z-hang-scale-silver-up-to-55-lb-001135">E-Z HANG SCALE</a></li>
      </ol></nav>
      <img src="https://cdn11.bigcommerce.com/s-rncilydun5/images/001135_main.jpg">
      <img src="https://cdn11.bigcommerce.com/s-rncilydun5/images/other-product_999.jpg">
      <script>{"name":"Inventory","value":"9"}</script>
      <span class="price">$39.99</span>
      <div>Reviews: 4.5 stars (12 reviews)</div>
    </body></html>`;

  test('parseBradleyPdp extracts every allowed field from the live-shaped markup', () => {
    const p = parseBradleyPdp(LIVE_PDP);
    expect(p.parsed).toBe(true);
    expect(p.name).toBe('E-Z HANG SCALE');
    expect(p.brand).toBe('KERBL');
    expect(p.distributorSku).toBe('001135');
    expect(p.mpn).toBe('099917');
    expect(p.upc).toBe('018653299524');
    expect(p.size).toBe('UP TO 55 LB');
    expect(p.unitOfMeasure).toBe('EA');
    expect(p.casePack).toBe('6');
    expect(p.weight).toBe('3.1 lb');
    expect(p.ingredients).toBe('nickel-plated hooks');
    expect(p.description).toMatch(/^For quick weight control/);
    expect(p.category).toContain('KERBL');
    // Gallery images: only URLs carrying the product SKU — the
    // recommendation-card image (other-product_999) is excluded.
    expect(p.images.length).toBe(1);
    expect(p.images[0]).toContain('001135');
  });

  test('live-shaped page: distributor-only + review data never enters the parse', () => {
    const p = parseBradleyPdp(LIVE_PDP);
    // Pallet Quantity, Type, Country, FOB Code are on the page but excluded.
    const flat = JSON.stringify(p);
    for (const forbidden of ['Pallet Quantity', '144', 'SILVER', 'CHINA', 'FOB', 'Inventory', '39.99', 'Reviews', '4.5 stars']) {
      expect(flat).not.toContain(forbidden);
    }
    // The page has no feature list and no dimensions — the record-level
    // assertion below proves they stay absent (BradleyPdpData intentionally
    // carries no such fields).
  });

  test('connector found path on the live-shaped page persists only allowed data', async () => {
    // Padded above the 4096-byte static-shell floor so the connector does
    // not route this offline test into the browser fallback.
    const searchPage = '<html><body><a href="/e-z-hang-scale-silver-up-to-55-lb-001135">E-Z HANG SCALE</a>' + ' '.repeat(5000) + '</body></html>';
    const { fetchPage } = makeFetcher({
      [SEARCH + '018653299524']: { ok: true, html: searchPage, finalUrl: SEARCH + '018653299524' },
      [PDP]: { ok: true, html: LIVE_PDP, finalUrl: PDP },
    });
    const result = await new BradleyConnector({ fetchPage }).lookupByGtin(makeRequest('018653299524'));
    expect(result.outcome).toBe('found');
    if (result.outcome !== 'found') return;
    const flat = JSON.stringify(result.record);
    // 'silver' intentionally excluded from this list: the product URL slug
    // legitimately contains it (Type: SILVER itself is excluded — see the
    // parse-level assertion).
    for (const forbidden of ['pallet', '144', 'china', 'fob', 'inventory', '39.99', 'review', 'rating']) {
      expect(flat.toLowerCase()).not.toContain(forbidden);
    }
    expect(result.record.features).toEqual([]);
    expect(result.record.dimensions).toBeNull();
    expect(result.record.category).toContain('KERBL');
  });
});
