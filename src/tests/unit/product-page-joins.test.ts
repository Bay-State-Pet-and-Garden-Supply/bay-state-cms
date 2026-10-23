import { describe, expect, it, beforeEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import {
  getProductPageAssignments,
  replaceProductPageJoins,
} from '../../db/repositories/page-repo';
import { preflightPagesSync } from '../../shopsite/page-sync-preflight';

const workspaceId = 'ws-page-joins-23';

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

function freshDb(): void {
  const wsPath = path.join(os.tmpdir(), `page-joins-23-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
  initDb(path.join(wsPath, '.baystate-cms', 'app.db'));
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
}

describe('verified product-page joins (P2 #23)', () => {
  beforeEach(async () => {
    freshDb();
    await preflightPagesSync({
      workspaceId,
      client: { fetchPagesXml: async () => ({ success: true, data: SAMPLE_PAGES_XML, errors: [] }) },
    });
  });

  it('resolves an approved additive page into XML and join rows', () => {
    const resolved = replaceProductPageJoins('SKU-JOIN-1', ['Dog Food']);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].pageName).toBe('Dog Food');
    const rows = getProductPageAssignments('SKU-JOIN-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].pageId).toBe(resolved[0].pageId);
  });

  it('clears both XML and join rows when the draft removes the page', () => {
    replaceProductPageJoins('SKU-JOIN-2', ['Dog Food', 'Cat Supplies']);
    expect(getProductPageAssignments('SKU-JOIN-2')).toHaveLength(2);
    replaceProductPageJoins('SKU-JOIN-2', []);
    expect(getProductPageAssignments('SKU-JOIN-2')).toEqual([]);
  });

  it('blocks ambiguous and unverified pages without touching rows', () => {
    expect(() => replaceProductPageJoins('SKU-JOIN-3', ['Missing Page'])).toThrow(/no verified identity/);
    expect(getProductPageAssignments('SKU-JOIN-3')).toEqual([]);
  });
});
