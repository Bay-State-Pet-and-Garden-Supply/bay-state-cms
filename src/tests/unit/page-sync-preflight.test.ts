import { describe, it, expect, beforeEach, beforeAll } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { getActivePageImport, listPageImports } from '../../db/repositories/page-import-repo';
import { assignProductToVerifiedPage, listVerifiedPageOptions } from '../../db/repositories/page-repo';
import { preflightPagesSync, reconcileProductsToActivePages } from '../../shopsite/page-sync-preflight';
import type { Product } from '../../shared/types';
import { sha256Hex } from '../../shared/stable-id';

let workspaceId = 'ws-preflight-test';
let testWorkspacePath: string;

const SAMPLE_PAGES_XML = `
<ShopSitePages version="15.0">
  <Response>
    <ResponseCode>1</ResponseCode>
    <ResponseDescription>success</ResponseDescription>
  </Response>
  <Pages>
    <Page>
      <PageID>1001</PageID>
      <Name>Dog Food</Name>
      <PageFileName>dog-food.html</PageFileName>
    </Page>
    <Page>
      <PageID>1002</PageID>
      <Name>Cat Supplies</Name>
      <PageFileName>cat-supplies.html</PageFileName>
    </Page>
  </Pages>
</ShopSitePages>
`;

const UPDATED_PAGES_XML = `
<ShopSitePages version="15.0">
  <Response>
    <ResponseCode>1</ResponseCode>
    <ResponseDescription>success</ResponseDescription>
  </Response>
  <Pages>
    <Page>
      <PageID>1001</PageID>
      <Name>Dog Food &amp; Treats</Name>
      <PageFileName>dog-food.html</PageFileName>
    </Page>
    <Page>
      <PageID>1002</PageID>
      <Name>Cat Supplies</Name>
      <PageFileName>cat-supplies.html</PageFileName>
    </Page>
    <Page>
      <PageID>1003</PageID>
      <Name>Garden &amp; Wild Bird</Name>
      <PageFileName>garden.html</PageFileName>
    </Page>
  </Pages>
</ShopSitePages>
`;

const MIXED_PAGES_XML = `
<ShopSitePages version="15.0">
  <Response>
    <ResponseCode>1</ResponseCode>
    <ResponseDescription>success</ResponseDescription>
  </Response>
  <Pages>
    <Page>
      <PageID>1001</PageID>
      <Name>Dog Food</Name>
      <PageFileName>dog-food.html</PageFileName>
    </Page>
    <Page>
      <Name>Unverified Name Only Page</Name>
    </Page>
  </Pages>
</ShopSitePages>
`;

function createFetcher(xml: string) {
  return {
    fetchPagesXml: async () => ({ success: true, data: xml, errors: [] }),
  };
}

function freshDb(): string {
  const wsPath = path.join(os.tmpdir(), `page-preflight-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
  const dbPath = path.join(wsPath, '.baystate-cms', 'app.db');
  initDb(dbPath);
  runMigrations();
  insertWorkspace({
    id: workspaceId,
    name: 'test',
    workspacePath: wsPath,
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
  return wsPath;
}

describe('preflightPagesSync', () => {
  beforeEach(() => {
    freshDb();
  });

  it('activates initial page catalog when no active import exists (baseline reconciliation)', async () => {
    const fetcher = createFetcher(SAMPLE_PAGES_XML);
    const result = await preflightPagesSync({
      workspaceId,
      client: fetcher,
      activatedBy: 'sync-job-initial',
    });

    expect(result.status).toBe('reconciled');
    expect(result.sourceHash).toBe(sha256Hex(SAMPLE_PAGES_XML));
    expect(result.verifiedCount).toBe(2);
    expect(result.message).toContain('Initial page catalog activated from ShopSite');

    const active = getActivePageImport(workspaceId);
    expect(active).not.toBeNull();
    expect(active?.status).toBe('active');
    expect(active?.sourceHash).toBe(sha256Hex(SAMPLE_PAGES_XML));

    const options = listVerifiedPageOptions(workspaceId);
    expect(options.length).toBe(2);
    expect(options.map(o => o.name).sort()).toEqual(['Cat Supplies', 'Dog Food']);
  });

  it('detects when local active import is already up-to-date and avoids re-activation', async () => {
    const fetcher = createFetcher(SAMPLE_PAGES_XML);

    // Initial activation
    await preflightPagesSync({ workspaceId, client: fetcher });
    const initialImports = listPageImports(workspaceId);
    expect(initialImports.length).toBe(1);

    // Second preflight with identical remote XML
    const result = await preflightPagesSync({ workspaceId, client: fetcher });
    expect(result.status).toBe('up_to_date');
    expect(result.sourceHash).toBe(sha256Hex(SAMPLE_PAGES_XML));
    expect(result.verifiedCount).toBe(2);
    expect(result.message).toContain('Page catalog verified up-to-date with ShopSite');

    // No extra imports created
    const postImports = listPageImports(workspaceId);
    expect(postImports.length).toBe(1);
  });

  it('automatically reconciles when remote ShopSite pages have changed', async () => {
    // 1. Initial import with 2 pages
    await preflightPagesSync({ workspaceId, client: createFetcher(SAMPLE_PAGES_XML) });
    expect(listVerifiedPageOptions(workspaceId).length).toBe(2);

    // 2. Preflight with updated remote pages (3 pages, 1 renamed)
    const result = await preflightPagesSync({
      workspaceId,
      client: createFetcher(UPDATED_PAGES_XML),
      activatedBy: 'sync-job-update',
    });

    expect(result.status).toBe('reconciled');
    expect(result.sourceHash).toBe(sha256Hex(UPDATED_PAGES_XML));
    expect(result.verifiedCount).toBe(3);
    expect(result.message).toContain('ShopSite Pages database changed');

    const active = getActivePageImport(workspaceId);
    expect(active?.sourceHash).toBe(sha256Hex(UPDATED_PAGES_XML));

    const imports = listPageImports(workspaceId);
    expect(imports.length).toBe(2);
    expect(imports.map(i => i.status).sort()).toEqual(['active', 'superseded']);

    const options = listVerifiedPageOptions(workspaceId);
    expect(options.length).toBe(3);
    expect(options.map(o => o.name).sort()).toEqual([
      'Cat Supplies',
      'Dog Food & Treats',
      'Garden & Wild Bird',
    ]);
  });

  it('filters out unverified name-only pages while activating verified ones', async () => {
    const fetcher = createFetcher(MIXED_PAGES_XML);
    const result = await preflightPagesSync({ workspaceId, client: fetcher });

    expect(result.status).toBe('reconciled');
    expect(result.verifiedCount).toBe(1);
    expect(result.warnings?.length).toBe(1);
    expect(result.warnings?.[0]).toContain('Unverified Name Only Page');

    const options = listVerifiedPageOptions(workspaceId);
    expect(options.length).toBe(1);
    expect(options[0].name).toBe('Dog Food');
  });

  it('fails closed when remote ShopSite download fails', async () => {
    const brokenFetcher = {
      fetchPagesXml: async () => ({ success: false, errors: ['Network timeout connecting to db_xml.cgi'], error: 'Network timeout' }),
    };

    expect(preflightPagesSync({ workspaceId, client: brokenFetcher })).rejects.toThrow('ShopSite Pages preflight failed');
    expect(getActivePageImport(workspaceId)).toBeNull();
  });

  it('reconciles renamed pages by stable identity and rejects name-only assignments', async () => {
    await preflightPagesSync({ workspaceId, client: createFetcher(SAMPLE_PAGES_XML) });
    const dogPage = listVerifiedPageOptions(workspaceId).find(page => page.name === 'Dog Food')!;
    assignProductToVerifiedPage('SKU-RENAME', dogPage.id, dogPage.name);

    const renamed = await preflightPagesSync({ workspaceId, client: createFetcher(UPDATED_PAGES_XML) });
    const product = {
      sku: 'SKU-RENAME',
      core: { productOnPages: [] },
      shopsite: {
        preserved: {
          unknownElements: { ProductOnPages: '<Name>Dog Food</Name>' },
          advancedBlocks: { ProductOnPages: '<Name>Dog Food</Name>' },
        },
      },
    } as unknown as Product;
    const reconciled = reconcileProductsToActivePages(workspaceId, renamed.sourceHash, [product])[0];
    // Verified names land on first-class core.productOnPages (raw display
    // name — the codec escapes at export); stale fragments are cleared.
    expect(reconciled.core.productOnPages).toEqual(['Dog Food & Treats']);
    expect(reconciled.shopsite.preserved.unknownElements.ProductOnPages).toBeUndefined();
    expect(reconciled.shopsite.preserved.advancedBlocks.ProductOnPages).toBeUndefined();

    const staleFragment = {
      sku: 'SKU-RENAME',
      shopsite: {
        preserved: {
          unknownElements: { ProductOnPages: '<Name>Dog Food</Name><Name>Removed Page</Name>' },
          advancedBlocks: {},
        },
      },
    } as unknown as Product;
    expect(() => reconcileProductsToActivePages(workspaceId, renamed.sourceHash, [staleFragment])).toThrow('unresolved ProductOnPages fragment');

    const nameOnly = {
      sku: 'SKU-NAME-ONLY',
      shopsite: {
        preserved: { unknownElements: { ProductOnPages: '<Name>Cat Supplies</Name>' }, advancedBlocks: {} },
      },
    } as unknown as Product;
    expect(() => reconcileProductsToActivePages(workspaceId, renamed.sourceHash, [nameOnly])).toThrow('without verified Page identity');
  });

  it('fails closed when an assigned page is removed from the active import', async () => {
    await preflightPagesSync({ workspaceId, client: createFetcher(SAMPLE_PAGES_XML) });
    const dogPage = listVerifiedPageOptions(workspaceId).find(page => page.name === 'Dog Food')!;
    assignProductToVerifiedPage('SKU-REMOVED', dogPage.id, dogPage.name);
    const removedXml = SAMPLE_PAGES_XML.replace(/\s*<Page>\s*<PageID>1001<\/PageID>[\s\S]*?<\/Page>/, '');
    const changed = await preflightPagesSync({ workspaceId, client: createFetcher(removedXml) });
    const product = {
      sku: 'SKU-REMOVED',
      shopsite: {
        preserved: { unknownElements: { ProductOnPages: '<Name>Dog Food</Name>' }, advancedBlocks: {} },
      },
    } as unknown as Product;
    expect(() => reconcileProductsToActivePages(workspaceId, changed.sourceHash, [product])).toThrow('outside the active ShopSite Pages import');
  });

  it('fails closed when remote ShopSite response code indicates error', async () => {
    const errorXml = `
      <ShopSitePages version="15.0">
        <Response>
          <ResponseCode>0</ResponseCode>
          <ResponseDescription>Authentication Failed</ResponseDescription>
        </Response>
        <Pages></Pages>
      </ShopSitePages>
    `;

    expect(preflightPagesSync({ workspaceId, client: createFetcher(errorXml) })).rejects.toThrow('Authentication Failed');
  });
});
