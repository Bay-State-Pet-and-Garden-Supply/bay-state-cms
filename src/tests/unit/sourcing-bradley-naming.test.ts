/**
 * Issue #106 Sequence 4 — Bradley ordered-candidate size/capacity/color
 * capture, brandSource provenance survival, and connector-axis declarations.
 *
 * Inline micro-fixtures (dt/dd + list-item + select shapes the parser
 * reads); no new fetches, no option-clicking, no frozen-snapshot mutation.
 */
import { describe, test, expect } from 'vitest';
import { BradleyConnector, parseBradleyPdp } from '../../onboarding/sourcing/connectors/bradley';
import { parseSourcingLookupResult } from '../../onboarding/sourcing/contracts';
import type { SourcingLookupRequest } from '../../onboarding/sourcing/contracts';
import type { ScraperFetchPage } from '../../onboarding/sourcing/html-scraper/contracts';

const UPC = '012345678905';
const SEARCH_URL = `https://www.bradleycaldwell.com/search?term=${UPC}`;
const PDP_URL = 'https://www.bradleycaldwell.com/test-widget-001135';

function specs(rows: string): string {
  return `<dl>${rows}</dl>`;
}
function specRow(label: string, value: string): string {
  return `<dt><strong>${label}</strong></dt><dd>${value}</dd>`;
}
function pdpShell(opts: { h1: string; brandLink?: string; specs?: string; listItems?: string; selects?: string }): string {
  return `<html><body><p><a>${opts.brandLink ?? ''}</a></p><h1>${opts.h1}</h1>${opts.specs ?? ''}<ul>${opts.listItems ?? ''}</ul>${opts.selects ?? ''}</body></html>`;
}
function searchHtml(): string {
  // Padded past the connector's 4096-byte static-shell floor so the fake
  // fetcher never trips the single browser fallback.
  const pad = 'x'.repeat(4200);
  return `<html><body><a href="/test-widget-001135">Test Widget</a><!--${pad}--></body></html>`;
}

function makeRequest(): SourcingLookupRequest {
  const controller = new AbortController();
  return {
    itemId: 'item-1',
    generationId: 'gen-1',
    upc: UPC,
    gtin: null,
    brandHint: null,
    registerName: null,
    connection: { id: 'conn-bradley', distributorId: 'bradley', connectorType: 'html_scraper', configuration: {} },
    secret: null,
    signal: controller.signal,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function fetcherFor(pdpHtml: string): ScraperFetchPage {
  return (async (url: string) => {
    if (url === SEARCH_URL) return { ok: true, html: searchHtml(), finalUrl: url };
    if (url === PDP_URL) return { ok: true, html: pdpHtml, finalUrl: url };
    return { ok: false, code: 'unexpected', message: `no fixture for ${url}` };
  }) as ScraperFetchPage;
}

describe('Bradley size-in-specs (existing behavior preserved)', () => {
  test('spec Size still parses', () => {
    const parsed = parseBradleyPdp(
      pdpShell({ h1: 'Widget', specs: specs(`${specRow('BCI Item Number', '001135')}${specRow('UPC', UPC)}${specRow('Size', '5 lb')}`) }),
    );
    expect(parsed.size).toBe('5 lb');
    expect(parsed.capacity).toBeNull();
    expect(parsed.color).toBeNull();
  });
});

describe('Bradley capacity below the H1', () => {
  test('spec Capacity wins; Capacity:/Volume: list items fall back in order', () => {
    const withSpec = parseBradleyPdp(
      pdpShell({
        h1: 'Widget',
        specs: specs(`${specRow('UPC', UPC)}${specRow('Capacity', '5 gal')}`),
        listItems: '<li>Capacity: 3 gal</li>',
      }),
    );
    expect(withSpec.capacity).toBe('5 gal');
    const listOnly = parseBradleyPdp(
      pdpShell({ h1: 'Widget', specs: specs(specRow('UPC', UPC)), listItems: '<li>Volume: 2.5 gal</li>' }),
    );
    expect(listOnly.capacity).toBe('2.5 gal');
  });
});

describe('Bradley color: own vs family vs unknown', () => {
  const colorSelect = (options: string, name = 'color'): string =>
    `<select name="${name}">${options}</select>`;
  test('selected option is ONE value (Navy Blue never split)', () => {
    const parsed = parseBradleyPdp(
      pdpShell({
        h1: 'Bucket',
        specs: specs(specRow('UPC', UPC)),
        selects: colorSelect('<option>Red</option><option selected>Navy Blue</option><option>Green</option>'),
      }),
    );
    expect(parsed.color).toBe('Navy Blue');
    expect(parsed.colorOptions).toEqual(['Red', 'Green']);
  });

  test('spec Color beats select state', () => {
    const parsed = parseBradleyPdp(
      pdpShell({
        h1: 'Bucket',
        specs: specs(`${specRow('UPC', UPC)}${specRow('Color', 'Black')}`),
        selects: colorSelect('<option selected>Red</option>'),
      }),
    );
    expect(parsed.color).toBe('Black');
  });

  test('family-only options: observed-null color with family diagnostics', async () => {
    const pdp = pdpShell({
      h1: 'Bucket',
      specs: specs(specRow('UPC', UPC)),
      selects: colorSelect('<option>Red</option><option>Navy Blue</option>'),
    });
    expect(parseBradleyPdp(pdp).color).toBeNull();
    const connector = new BradleyConnector({ fetchPage: fetcherFor(pdp) });
    const result = await connector.lookupByGtin(makeRequest());
    expect(result.outcome).toBe('found');
    if (result.outcome !== 'found') return;
    expect(result.record.attributes.color).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('family:') && w.includes('Navy Blue'))).toBe(true);
  });
});

describe('Bradley malformed markup', () => {
  test('parser never throws; observed nulls', () => {
    const parsed = parseBradleyPdp('<html><body><div>not a pdp {{{</div><script type="application/ld+json">{oops</script></body></html>');
    expect(parsed.brand).toBeNull();
    expect(parsed.brandSource).toBeNull();
    expect(parsed.size).toBeNull();
    expect(parsed.capacity).toBeNull();
    expect(parsed.color).toBeNull();
    expect(parsed.colorOptions).toEqual([]);
  });

  test('lookup performs exactly search+PDP fetches; malformed/layout-change adds zero (T4)', async () => {
    const counting = (pdpHtml: string, calls: string[]) => {
      const inner = fetcherFor(pdpHtml);
      return (async (url: string, opts: { signal: AbortSignal; deadlineAt: string }) => {
        calls.push(url);
        return inner(url, opts);
      }) as ScraperFetchPage;
    };
    // Happy path: exactly two fetches (search + PDP), no browser fallback.
    const happyCalls: string[] = [];
    const happy = new BradleyConnector({ fetchPage: counting(pdpShell({ h1: 'Widget' }), happyCalls) });
    await happy.lookupByGtin(makeRequest());
    expect(happyCalls).toEqual([SEARCH_URL, PDP_URL]);
    // Malformed PDP: still exactly two fetches, zero extra fallback calls.
    const malformedCalls: string[] = [];
    const malformed = new BradleyConnector({
      fetchPage: counting('<html><body><div>not a pdp {{{</div></body></html>', malformedCalls),
    });
    await malformed.lookupByGtin(makeRequest());
    expect(malformedCalls).toEqual([SEARCH_URL, PDP_URL]);
  });
});

describe('Lookup-result boundary (engine gate)', () => {
  const baseRecord = {
    matchedIdentifier: UPC,
    distributorUpc: UPC,
    gtin: null,
    distributorSku: '001135',
    name: 'Acme Bucket',
    description: null,
    brand: 'Acme',
    brandSource: 'spec',
    manufacturerPartNumber: null,
    weight: null,
    features: [],
    category: null,
    dimensions: null,
    casePack: null,
    unitOfMeasure: null,
    ingredients: null,
    attributes: { size: '5 gal', capacity: '5 gal', color: 'Navy Blue' },
    imageUrls: [],
    sourceUrl: null,
    catalogVersion: null,
    observedAt: new Date().toISOString(),
    expiresAt: null,
  };
  test('brandSource + declaredVariantAxes round-trip the zod boundary', () => {
    const parsed = parseSourcingLookupResult({
      outcome: 'found',
      record: baseRecord,
      matchedFields: ['matchedIdentifier', 'capacity', 'color'],
      warnings: [],
      declaredVariantAxes: ['size', 'capacity', 'color'],
    });
    expect(parsed?.outcome).toBe('found');
    if (parsed?.outcome !== 'found') return;
    expect(parsed.record.brandSource).toBe('spec');
    expect(parsed.declaredVariantAxes).toEqual(['size', 'capacity', 'color']);
  });

  test('oversized declarations / overlong brandSource fail closed (null)', () => {
    expect(
      parseSourcingLookupResult({
        outcome: 'found',
        record: { ...baseRecord, brandSource: 'x'.repeat(65) },
        matchedFields: [],
        warnings: [],
      }),
    ).toBeNull();
    expect(
      parseSourcingLookupResult({
        outcome: 'found',
        record: baseRecord,
        matchedFields: [],
        warnings: [],
        declaredVariantAxes: Array.from({ length: 17 }, (_, i) => `axis${i}`),
      }),
    ).toBeNull();
  });
});

describe('Bradley brandSource survives the lookup result', () => {
  test('spec brand (no adjacent link) yields brand + spec provenance + declarations', async () => {
    const pdp = pdpShell({
      h1: 'Acme Bucket',
      specs: specs(
        `${specRow('UPC', UPC)}${specRow('BCI Item Number', '001135')}${specRow('Brand', 'Acme')}${specRow('Size', '5 gal')}${specRow('Capacity', '5 gal')}`,
      ),
      selects: '<select name="color"><option selected>Navy Blue</option></select>',
    });
    const connector = new BradleyConnector({ fetchPage: fetcherFor(pdp) });
    const result = await connector.lookupByGtin(makeRequest());
    expect(result.outcome).toBe('found');
    if (result.outcome !== 'found') return;
    expect(result.record.brand).toBe('Acme');
    expect(result.record.brandSource).toBe('spec');
    expect(result.record.attributes).toMatchObject({ size: '5 gal', capacity: '5 gal', color: 'Navy Blue' });
    expect(result.matchedFields).toEqual(expect.arrayContaining(['capacity', 'color']));
    expect(result.declaredVariantAxes).toEqual(['size', 'capacity', 'color']);
  });

  test('adjacent-link brand keeps adjacent_link provenance', () => {
    const parsed = parseBradleyPdp(
      pdpShell({ h1: 'Bucket', brandLink: 'Acme', specs: specs(specRow('UPC', UPC)) }),
    );
    expect(parsed.brand).toBe('Acme');
    expect(parsed.brandSource).toBe('adjacent_link');
  });
});
