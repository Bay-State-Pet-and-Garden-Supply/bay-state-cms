import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrgillConnector, isOrgillSearchPage, parseOrgillPdp, parseOrgillSearchCandidates } from '../../onboarding/sourcing/connectors/orgill';
import type { SourcingLookupRequest } from '../../onboarding/sourcing/contracts';
import type { ScraperFetchPage, ScraperFetchPageResult } from '../../onboarding/sourcing/html-scraper/contracts';

const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'sourcing', 'html-scrapers', 'orgill');
const FIXTURES: Record<string, string> = {};
for (const name of [
  'found-search.html', 'found-pdp.html', 'not-found.html', 'wrong-variant-pdp.html',
  'auth-required.html', 'auth-required-alt.html', 'auth-failed.html', 'unexpected-markup.html',
  'direct-pdp-new.html', 'no-results-new.html',
]) {
  FIXTURES[name] = readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

const SEARCH = 'https://www.orgill.com/SearchResultN.aspx?ddlhQ=';
const PDP = 'https://www.orgill.com/ProductDetail.aspx?itemNumber=204711';

/** Deterministic fake fetcher: URL → fixture. Records every call for assertions. */
function makeFetcher(overrides: Record<string, ScraperFetchPageResult> = {}) {
  const calls: Array<{ url: string; browserRequired?: boolean }> = [];
  const fetchPage: ScraperFetchPage = async (url, opts) => {
    calls.push({ url, browserRequired: opts.browserRequired });
    const hit = overrides[url];
    if (hit) return hit;
    if (url.startsWith(SEARCH + '755625321923')) {
      return { ok: true, html: FIXTURES['found-search.html'], finalUrl: url };
    }
    if (url.startsWith(SEARCH + '755625321924')) {
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

const VALID_SECRET = JSON.stringify({ username: 'ops-user', password: 's3cret-pass' });

function makeRequest(upc: string, extra: Partial<SourcingLookupRequest> = {}): SourcingLookupRequest {
  const controller = new AbortController();
  return {
    itemId: 'item-1',
    generationId: 'gen-1',
    upc,
    gtin: null,
    brandHint: null,
    registerName: null,
    connection: { id: 'conn-orgill', distributorId: 'orgill', connectorType: 'html_scraper', configuration: {} },
    secret: VALID_SECRET,
    signal: controller.signal,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    ...extra,
  };
}

describe('OrgillConnector — found (exact UPC match, authenticated)', () => {
  test('returns a merchandising-depth record with exact identity', async () => {
    const { fetchPage } = makeFetcher();
    const connector = new OrgillConnector({ fetchPage, now: () => '2026-08-15T00:00:00.000Z' });
    const result = await connector.lookupByGtin(makeRequest('755625321923'));
    expect(result.outcome).toBe('found');
    if (result.outcome !== 'found') return;
    expect(result.record.matchedIdentifier).toBe('755625321923');
    expect(result.record.name).toBe('Landscapers Select 34609 PCL-P Shovel, 16 ga, Hardwood Handle, 45 in L Handle');
    expect(result.record.brand).toBe('LANDSCAPERS SELECT');
    expect(result.record.distributorSku).toBe('204711');
    expect(result.record.manufacturerPartNumber).toBe('34609');
    expect(result.record.weight).toBe('20 lb');
    expect(result.record.dimensions).toBe('45 in L');
    expect(result.record.casePack).toBe('4');
    expect(result.record.attributes.packCount).toBe('4');
    expect(result.record.unitOfMeasure).toBe('EA');
    expect(result.record.description).toMatch(/^Professional-grade shovel/);
    expect(result.record.category).toBe('Lawn & Garden');
    expect(result.record.features).toEqual(['16 gauge steel blade', 'Hardwood handle']);
    expect(result.record.sourceUrl).toBe(PDP);
    expect(result.record.observedAt).toBe('2026-08-15T00:00:00.000Z');
    // Forbidden fields are absent.
    expect(result.record).not.toHaveProperty('price');
    expect(result.record).not.toHaveProperty('inventory');
    expect(result.record).not.toHaveProperty('material');
    expect(result.record).not.toHaveProperty('npkRatio');
    expect(result.matchedFields).toContain('matchedIdentifier');
    expect(result.matchedFields).toContain('name');
    expect(result.matchedFields).toContain('casePack');
  });

  test('images are HTTPS display-only candidates on the orgill host only', async () => {
    const { fetchPage } = makeFetcher();
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('755625321923'));
    expect(result.outcome).toBe('found');
    if (result.outcome !== 'found') return;
    expect(result.record.imageUrls.length).toBeGreaterThan(0);
    for (const u of result.record.imageUrls) {
      expect(u.startsWith('https://')).toBe(true);
      expect(new URL(u).hostname.endsWith('orgill.com')).toBe(true);
    }
  });

  test('providerId is orgill and requiresSecret is true', async () => {
    const connector = new OrgillConnector({ fetchPage: async () => ({ ok: false, code: 'unexpected', message: 'x' }) });
    expect(connector.providerId).toBe('orgill');
    expect(connector.connectorType).toBe('html_scraper');
    expect(connector.requiresSecret).toBe(true);
  });
});

describe('OrgillConnector — new storefront template (direct-PDP, observed 2026-08-15)', () => {
  test('parseOrgillPdp extracts the new labeled template', () => {
    const data = parseOrgillPdp(FIXTURES['direct-pdp-new.html']);
    expect(data.parsed).toBe(true);
    expect(data.upc).toBe('755625321923');
    expect(data.name).toMatch(/shovel/i);
    expect(data.brand).toBe('LANDSCAPERS SELECT');
    expect(data.distributorSku).toBe('7618085');
    expect(data.mpn).toBe('34609');
    expect(data.casePack).toBe('6');
    expect(data.weight).toBe('4');
    expect(data.features).toContain('45 in hardwood handle');
    expect(data.features).toContain('#2 blade, 16 ga');
    expect(data.description).toMatch(/Square point shovel/i);
    expect(data.images.length).toBeGreaterThan(0);
    for (const u of data.images) {
      expect(u.startsWith('https://')).toBe(true);
      expect(u).not.toMatch(/ImageGallery\/menu/i);
    }
    expect(data.images.some((u) => u.includes('images1.orgill.com') && u.includes('7618085.jpg'))).toBe(true);
  });

  test('lookup on a direct-PDP search response returns found with exact identity', async () => {
    const { fetchPage, calls } = makeFetcher({
      [SEARCH + '755625321923']: { ok: true, html: FIXTURES['direct-pdp-new.html'], finalUrl: SEARCH + '755625321923' },
    });
    const result = await new OrgillConnector({ fetchPage, now: () => '2026-08-15T12:00:00.000Z' }).lookupByGtin(
      makeRequest('755625321923'),
    );
    expect(result.outcome).toBe('found');
    if (result.outcome !== 'found') return;
    expect(result.record.matchedIdentifier).toBe('755625321923');
    expect(result.record.distributorUpc).toBe('755625321923');
    expect(result.record.brand).toBe('LANDSCAPERS SELECT');
    expect(result.record.distributorSku).toBe('7618085');
    expect(result.record.manufacturerPartNumber).toBe('34609');
    expect(result.record.casePack).toBe('6');
    expect(result.record.sourceUrl).toBe(SEARCH + '755625321923');
    expect(result.matchedFields).toContain('matchedIdentifier');
    expect(result.matchedFields).toContain('name');
    // No candidate PDP fetch: the search response WAS the product page.
    expect(calls.length).toBe(1);
  });

  test('live no-results-new page yields SKU-bearing search candidates', () => {
    const candidates = parseOrgillSearchCandidates(FIXTURES['no-results-new.html']);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((url) => /\/index\.aspx\?[^#]*\bsku=\d+/i.test(url))).toBe(true);
  });

  test('live 43-result page proceeds to PDP stage instead of false no_exact_match', async () => {
    // The old behavior returned not_stocked/no-exact-match without ever
    // fetching a PDP (dead candidate regex). Now candidates are found and
    // the PDP fetch decides: with no PDP fixture stubbed the transport fails
    // closed with source_error (fail-closed, never a fabricated outcome).
    const { fetchPage } = makeFetcher({
      [SEARCH + '999999999999']: { ok: true, html: FIXTURES['no-results-new.html'], finalUrl: SEARCH + '999999999999' },
    });
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('999999999999'));
    expect(result.outcome).toBe('source_error');
  });
});

describe('OrgillConnector — fail-closed outcomes', () => {
  test('explicit no-result page → not_stocked:no_exact_match', async () => {
    const { fetchPage, calls } = makeFetcher();
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('000000000000'));
    expect(result).toEqual({ outcome: 'not_stocked', reason: expect.stringContaining('no exact match') });
    expect(calls.map((c) => c.url)).toEqual([SEARCH + '000000000000']);
  });

  test('valid page whose UPC differs from the lookup identifier → not_stocked:wrong_variant', async () => {
    const { fetchPage } = makeFetcher();
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('755625321924'));
    expect(result.outcome).toBe('not_stocked');
    if (result.outcome === 'not_stocked') expect(result.reason).toContain('wrong variant');
  });

  test('search returns the login form → source_error:auth_required', async () => {
    const { fetchPage, calls } = makeFetcher({
      [SEARCH + '755625321923']: { ok: true, html: FIXTURES['auth-required.html'], finalUrl: SEARCH + '755625321923' },
    });
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('755625321923'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('auth_required');
    expect(calls.length).toBe(1);
  });

  test('login-redirect interstitial (auth-required-alt) → source_error:auth_required', async () => {
    const { fetchPage } = makeFetcher({
      [SEARCH + '755625321923']: { ok: true, html: FIXTURES['auth-required-alt.html'], finalUrl: SEARCH + '755625321923' },
    });
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('755625321923'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('auth_required');
  });

  test('runner-level auth failure → source_error:auth_failed (durable code)', async () => {
    const { fetchPage } = makeFetcher({
      [SEARCH + '755625321923']: { ok: false, code: 'auth_failed', message: 'login could not establish an authenticated session' },
    });
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('755625321923'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('auth_failed');
  });

  test('runner-level expired session after re-login → source_error:auth_expired', async () => {
    const { fetchPage } = makeFetcher({
      [SEARCH + '755625321923']: { ok: false, code: 'auth_expired', message: 'session re-authentication failed' },
    });
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('755625321923'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('auth_expired');
  });

  test('transport failure on search → source_error with the stable code', async () => {
    const { fetchPage } = makeFetcher({
      [SEARCH + '755625321923']: { ok: false, code: 'timeout', message: 'transport timed out' },
    });
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('755625321923'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('timeout');
  });

  test('missing secret → source_error:secret_missing without any fetch', async () => {
    const { fetchPage, calls } = makeFetcher();
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('755625321923', { secret: null }));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('secret_missing');
    expect(calls.length).toBe(0);
  });

  test('malformed credential JSON → source_error:credential_invalid without any fetch', async () => {
    const { fetchPage, calls } = makeFetcher();
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('755625321923', { secret: '{"username":"u"}' }));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('credential_invalid');
    expect(calls.length).toBe(0);
  });

  test('pre-aborted signal → source_error:cancelled without any fetch', async () => {
    const { fetchPage, calls } = makeFetcher();
    const controller = new AbortController();
    controller.abort();
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('755625321923', { signal: controller.signal }));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('cancelled');
    expect(calls.length).toBe(0);
  });

  test('expired deadline → source_error:timeout without any fetch', async () => {
    const { fetchPage, calls } = makeFetcher();
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(
      makeRequest('755625321923', { deadlineAt: new Date(Date.now() - 1000).toISOString() }),
    );
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('timeout');
    expect(calls.length).toBe(0);
  });

  test('no 8-14 digit identifier → source_error:no_identifier', async () => {
    const { fetchPage, calls } = makeFetcher();
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('001135'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('no_identifier');
    expect(calls.length).toBe(0);
  });

  test('invalid connection configuration fails closed as config_invalid', async () => {
    const { fetchPage } = makeFetcher();
    const connector = new OrgillConnector({ fetchPage });
    const request = makeRequest('755625321923');
    request.connection = { ...request.connection, configuration: { loginUrl: 'https://evil.example.com' } };
    const result = await connector.lookupByGtin(request);
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('config_invalid');
  });

  test('PDP fetch transport error maps to bounded source_error', async () => {
    const { fetchPage } = makeFetcher({
      [PDP]: { ok: false, code: 'origin_blocked', message: 'final URL left the provider origin' },
    });
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('755625321923'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('origin_blocked');
  });

  test('unrecognized markup → source_error:unexpected_markup', async () => {
    const { fetchPage } = makeFetcher({
      [SEARCH + '755625321923']: { ok: true, html: FIXTURES['unexpected-markup.html'], finalUrl: SEARCH + '755625321923' },
    });
    const result = await new OrgillConnector({ fetchPage }).lookupByGtin(makeRequest('755625321923'));
    expect(result.outcome).toBe('source_error');
    if (result.outcome === 'source_error') expect(result.code).toBe('unexpected_markup');
  });
});

describe('OrgillConnector — LIVE-shaped markup (captured 2026-08-15 from www.orgill.com)', () => {
  // Faithful fragment of the authenticated SKU page: name in lblDescriptionxs,
  // UPC in lblRetailUpc, overview description, detail-row features, labeled
  // weight/UOM/dimension rows, images on images.orgill.com — plus the
  // price/inventory the page really carries (must never be extracted).
  const LIVE_PDP = `
    <html><body>
      <div id="productInfoDiv">
        <h4 class="text-detail-description"><span id="cphMainContent_ctl00_lblDescriptionxs">Landscapers Select 34609 PCL-P Shovel, 16 ga, Hardwood Handle, 45 in L Handle</span></h4>
        <table><tr><td><span id="cphMainContent_ctl00_lblOrgillItemNumber">7618085 Y</span></td></tr>
        <tr><td><span id="cphMainContent_ctl00_lblModelNumber">34609 </span></td></tr>
        <tr><td><span id="cphMainContent_ctl00_lblVendorName">LANDSCAPERS SELECT </span></td></tr>
        <tr><td><span id="cphMainContent_ctl00_lblRetailUpc">755625321923</span></td></tr></table>
        <div id="productDetaillg">
          <span id="cphMainContent_ctl00_lblProductOverview"><h3 class="text-details-header">PRODUCT OVERVIEW</h3><p class="text-details-description">Square point shovel with #2 blade size, matte black painted heads and 45 in hardwood handle.</p></span>
          <h4 class="text-details-header">Features</h4>
          <div class="row"><div class="col-sm-12">
            <div class="row detail-row-border-top"><div class="col-xs-12 detail-row"><span><li>45 in hardwood handle</li></span></div></div>
            <div class="row detail-row-border-top"><div class="col-xs-12 detail-row"><span><li>#2 blade, 16 ga</li></span></div></div>
          </div></div>
          <div class="row padding-top-20"><div><h5><strong>Shipping Unit Dimensions:</strong></h5></div>
            <div class="row detail-row-border-top"><div class="detail-row"><strong>Width(in):</strong></div><div class="detail-row">9.75</div></div>
            <div class="row detail-row-border-top"><div class="detail-row"><strong>Height(in):</strong></div><div class="detail-row">12</div></div>
            <div class="row detail-row-border-top"><div class="detail-row"><strong>Length(in):</strong></div><div class="detail-row">63</div></div>
          </div>
          <div class="row detail-row-border-top"><div class="detail-row"><strong>Weight(lb):</strong></div><div class="detail-alternate-row">4</div></div>
          <div class="row detail-row-border-top"><div class="detail-row"><strong>Unit of Meas.:</strong></div><div class="detail-alternate-row">EA </div></div>
          <img class="productimg100-list" src="https://images.orgill.com/200x200/4703823.jpg">
          <img class="productimg100-list" src="https://images.orgill.com/200x200/9121294.jpg">
          <span class="price">$52.42</span>
          <span>Available: 37 on hand Inventory</span>
        </div>
      </div>
    </body></html>`;

  test('live-shaped PDP: every present merchandising field extracts via the new selectors', () => {
    const p = parseOrgillPdp(LIVE_PDP);
    expect(p.name).toBe('Landscapers Select 34609 PCL-P Shovel, 16 ga, Hardwood Handle, 45 in L Handle');
    expect(p.brand).toBe('LANDSCAPERS SELECT');
    expect(p.upc).toBe('755625321923');
    expect(p.distributorSku).toBe('7618085 Y');
    expect(p.mpn).toBe('34609');
    expect(p.weight).toBe('4');
    expect(p.unitOfMeasure).toBe('EA');
    expect(p.dimensions).toBe('9.75 x 12 x 63');
    expect(p.description).toMatch(/^Square point shovel/);
    expect(p.features).toEqual(['45 in hardwood handle', '#2 blade, 16 ga']);
    expect(p.images).toEqual([
      'https://images.orgill.com/200x200/4703823.jpg',
      'https://images.orgill.com/200x200/9121294.jpg',
    ]);
    // Case-pack and category labels are genuinely absent on this live page.
    expect(p.casePack).toBeNull();
    expect(p.category).toBeNull();
    expect(p.parsed).toBe(true);
  });

  test('live-shaped PDP: price/inventory/stock markup is never extracted', () => {
    const p = parseOrgillPdp(LIVE_PDP);
    expect(p.features.join(' ')).not.toMatch(/price|\$|inventory|on hand|\b52\.42\b/i);
    expect(p.description ?? '').not.toMatch(/\$\d/);
  });

  test('connector direct-PDP path: search resolving to the live-shaped page returns found with exact identity', async () => {
    const fetchPage: ScraperFetchPage = async (url) =>
      url.startsWith(SEARCH)
        ? { ok: true, html: LIVE_PDP, finalUrl: 'https://www.orgill.com/index.aspx?tab=7&sku=7618085' }
        : { ok: false, code: 'unexpected', message: 'no fixture' };
    const connector = new OrgillConnector({ fetchPage, now: () => '2026-08-15T00:00:00.000Z' });
    const result = await connector.lookupByGtin(makeRequest('755625321923'));
    expect(result.outcome).toBe('found');
    if (result.outcome !== 'found') return;
    expect(result.record.matchedIdentifier).toBe('755625321923');
    expect(result.record.distributorUpc).toBe('755625321923');
    expect(result.record.distributorSku).toBe('7618085 Y');
    expect(result.record.weight).toBe('4');
    expect(result.record.dimensions).toBe('9.75 x 12 x 63');
    expect(result.record.description).toMatch(/^Square point shovel/);
    expect(result.record.features).toContain('45 in hardwood handle');
    expect(result.record.imageUrls[0]).toContain('images.orgill.com');
    expect(result.record.sourceUrl).toBe('https://www.orgill.com/index.aspx?tab=7&sku=7618085');
    // Forbidden fields stay absent at the record boundary.
    expect(result.record).not.toHaveProperty('price');
    expect(result.record).not.toHaveProperty('inventory');
    expect(result.record).not.toHaveProperty('stock');
    expect(result.matchedFields).toContain('dimensions');
    expect(result.matchedFields).toContain('features');
    expect(result.matchedFields).toContain('imageUrls');
  });
});

describe('OrgillConnector — pure parser units', () => {
  test('parseOrgillSearchCandidates: ProductDetail links, deduped, capped', () => {
    const urls = parseOrgillSearchCandidates(FIXTURES['found-search.html']);
    expect(urls).toEqual([PDP]);
    expect(parseOrgillSearchCandidates(FIXTURES['not-found.html'])).toEqual([]);
  });

  test('parseOrgillPdp: exact field extraction with fallbacks and forbidden fields absent', () => {
    const p = parseOrgillPdp(FIXTURES['found-pdp.html']);
    expect(p.name).toBe('Landscapers Select 34609 PCL-P Shovel, 16 ga, Hardwood Handle, 45 in L Handle');
    expect(p.brand).toBe('LANDSCAPERS SELECT');
    expect(p.upc).toBe('755625321923');
    expect(p.distributorSku).toBe('204711');
    expect(p.mpn).toBe('34609');
    expect(p.weight).toBe('20 lb');
    expect(p.dimensions).toBe('45 in L');
    expect(p.casePack).toBe('4');
    expect(p.unitOfMeasure).toBe('EA');
    expect(p.category).toBe('Lawn & Garden');
    expect(p.features).toEqual(['16 gauge steel blade', 'Hardwood handle']);
    expect(p.description).toMatch(/^Professional-grade shovel/);
    expect(p.images[0]).toBe('https://www.orgill.com/images/products/204711.jpg');
    expect(p.parsed).toBe(true);
  });

  test('parseOrgillPdp: wrong-variant page parses but carries a different UPC', () => {
    const p = parseOrgillPdp(FIXTURES['wrong-variant-pdp.html']);
    expect(p.upc).toBe('755625321924');
    expect(p.name).toBe('Landscapers Select 34609 PCL-P Shovel, 16 ga, Hardwood Handle, 45 in L Handle');
    expect(p.parsed).toBe(true);
  });

  test('parseOrgillPdp: login form and unexpected markup are not parsed as PDPs', () => {
    expect(parseOrgillPdp(FIXTURES['auth-required.html']).parsed).toBe(false);
    expect(parseOrgillPdp(FIXTURES['unexpected-markup.html']).parsed).toBe(false);
  });
});
