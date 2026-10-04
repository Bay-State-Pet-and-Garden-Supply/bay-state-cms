import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { downloadPagesFromShopSite } from '../../shopsite/page-download-service';
import { sha256Hex } from '../../shared/stable-id';

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'shopsite-pages-bay-state-redacted.xml');

function fixtureText(): string {
  return fs.readFileSync(FIXTURE_PATH, 'utf8');
}

function okFetcher(xml: string) {
  return {
    fetchPagesXml: async () => ({ success: true, data: xml, errors: [] }),
  };
}

const FAILED_FETCHER = {
  fetchPagesXml: async () => ({ success: false, errors: ['boom'], error: 'boom' }),
};

describe('downloadPagesFromShopSite', () => {
  it('explicitly requests identity fields rather than inheriting an incomplete ShopSite field map', async () => {
    const result = await downloadPagesFromShopSite({
      fetchPagesXml: async options => options?.version === '14.0' && ['Name', 'File name', 'Page ID', 'Title'].every(field => options.fields?.includes(field))
        ? { success: true, data: fixtureText(), errors: [] }
        : { success: true, data: '<ShopSitePages><Pages><Page><Name>First page</Name></Page><Page><Name/></Page></Pages></ShopSitePages>', errors: [] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.counts).toEqual({ total: 12, verified: 12, nameOnly: 0, withParent: 0 });
  });

  it('rejects nameless exported records rather than inventing an unnamed assignment page', async () => {
    const result = await downloadPagesFromShopSite(okFetcher('<ShopSitePages><Pages><Page><PageID>1</PageID><Name/></Page></Pages></ShopSitePages>'));
    expect(result.ok).toBe(false);
  });
  it('normalizes a successful ShopSite Pages download into an activation-ready preview', async () => {
    const xml = fixtureText();
    const result = await downloadPagesFromShopSite(okFetcher(xml));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.sourceHash).toBe(sha256Hex(xml));
    expect(result.parserFormatVersion).toBe('shopsite-pages-xml-1');
    expect(result.counts).toEqual({ total: 12, verified: 12, nameOnly: 0, withParent: 0 });
    expect(result.records[0].identity.kind).toBe('exported_guid');
    expect(result.warnings).toEqual([]);
    expect(result.responseCode).toBe('1');
  });

  it('fails closed when ShopSite reports a non-success ResponseCode', async () => {
    const xml = [
      '<ShopSitePages version="15.0">',
      '  <Response>',
      '    <ResponseCode>0</ResponseCode>',
      '    <ResponseDescription>Invalid password</ResponseDescription>',
      '  </Response>',
      '  <Pages>',
      '    <Page><PageID>1</PageID><Name>Ghost</Name></Page>',
      '  </Pages>',
      '</ShopSitePages>',
    ].join('\n');

    const result = await downloadPagesFromShopSite(okFetcher(xml));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Invalid password');
  });

  it('fails closed when a successful envelope contains zero pages', async () => {
    const xml = [
      '<ShopSitePages version="15.0">',
      '  <Response><ResponseCode>1</ResponseCode><ResponseDescription>success</ResponseDescription></Response>',
      '  <Pages></Pages>',
      '</ShopSitePages>',
    ].join('\n');

    const result = await downloadPagesFromShopSite(okFetcher(xml));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('contained no pages');
  });

  it('fails closed on a transport error', async () => {
    const result = await downloadPagesFromShopSite(FAILED_FETCHER);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('boom');
  });

  it('flags pages without a PageID as name-only (excluded from activation)', async () => {
    const xml = [
      '<ShopSitePages version="15.0">',
      '  <Response><ResponseCode>1</ResponseCode><ResponseDescription>success</ResponseDescription></Response>',
      '  <Pages>',
      '    <Page><Name>Legacy Page</Name></Page>',
      '  </Pages>',
      '</ShopSitePages>',
    ].join('\n');

    const result = await downloadPagesFromShopSite(okFetcher(xml));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.counts).toEqual({ total: 1, verified: 0, nameOnly: 1, withParent: 0 });
    expect(result.records[0].identity.kind).toBe('unverified_name_only');
    expect(result.warnings.length).toBe(1);
  });
});
