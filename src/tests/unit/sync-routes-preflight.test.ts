import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'bun:test';
import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { upsertConnection } from '../../db/repositories/connection-repo';
import { createChangeSet, upsertChangeSetItem } from '../../db/repositories/change-set-repo';
import { approveChangeSet } from '../../server/services/change-set-service';
import { GitClient } from '../../git/git-client';
import { createWorkspaceDirs } from '../../git/workspace-files';
import { listSyncJobEvents } from '../../db/repositories/sync-job-repo';
import { getActivePageImport } from '../../db/repositories/page-import-repo';
import syncRoutes from '../../server/routes/sync-routes';
import { sha256Hex } from '../../shared/stable-id';
import type { Product } from '../../shared/types';

let workspaceId = 'ws-sync-preflight';
let workspacePath = '';

const SAMPLE_PAGES_XML = `
<ShopSitePages version="15.0">
  <Response>
    <ResponseCode>1</ResponseCode>
    <ResponseDescription>success</ResponseDescription>
  </Response>
  <Pages>
    <Page>
      <PageID>2001</PageID>
      <Name>Pet Food</Name>
      <PageFileName>pet-food.html</PageFileName>
    </Page>
  </Pages>
</ShopSitePages>
`;

function createSampleProduct(sku: string): Product {
  return {
    schemaVersion: 1,
    id: `prod-${sku}`,
    sku,
    status: 'active',
    core: {
      name: `Sample Product ${sku}`,
      price: '19.99',
      salePrice: null,
      description: 'A great product',
      taxable: true,
      availability: 'in stock',
      weight: null,
      inventory: {
        quantityOnHand: 10,
        lowStockThreshold: null,
        outOfStockLimit: null,
      },
      media: {
        primary: null,
        additional: [],
      },
      seo: {
        fileName: null,
        searchKeywords: null,
        googleProductCategory: null,
      },
      productOnPages: [],
    },
    customFields: {},
    shopsite: {
      productId: null,
      productGuid: null,
      xmlVersion: '15.0',
      lastPulledAt: null,
      lastRemoteHash: null,
      lastSyncedAt: null,
      source: {
        dbname: 'products',
        uniqueName: 'SKU',
      },
      preserved: {
        unknownElements: {},
        advancedBlocks: {},
        rawAttributes: {},
      },
    },
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archivedAt: null,
    },
  };
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;

  workspacePath = path.join(os.tmpdir(), `sync-preflight-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();

  insertWorkspace({
    id: workspaceId,
    name: 'test',
    workspacePath,
    gitPath: `${workspacePath}/.git`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });

  upsertConnection({
    workspaceId,
    cgiBaseUrl: 'https://store.example.com/cgi-bin/merchant',
    merchantId: 'test-merchant',
    passwordSecretRef: 'test-password',
    authStrategy: 'basic',
  });
  createWorkspaceDirs(workspacePath);
  fs.writeFileSync(path.join(workspacePath, '.gitignore'), 'exports/\n');
  const git = new GitClient(workspacePath);
  git.init();
  git.add(['.gitignore']);
  git.commit('Preflight test baseline');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api', syncRoutes);
  return app;
}

describe('Sync Routes — Pages Preflight Integration', () => {
  it('runs page preflight, reconciles page catalog, and logs events during push-publish', async () => {
    // 1. Setup change set
    const changeSet = createChangeSet({
      workspaceId,
      title: 'Push with Preflight',
      description: 'preflight test',
      baseCommit: new GitClient(workspacePath).getHeadHash(),
    });
    const product = createSampleProduct('SKU-100');
    const draftJson = JSON.stringify(product);
    upsertChangeSetItem({
      changeSetId: changeSet.id,
      sku: product.sku,
      operation: 'create',
      draftJson,
      baseJson: null,
      draftHash: sha256Hex(draftJson),
    });
    const approved = approveChangeSet(changeSet.id, workspacePath);
    expect(approved.success).toBe(true);

    // 2. Mock fetch: db_xml serves pages XML for dbname=pages and echoes the
    // uploaded products XML as the live products census (so the family
    // import reconcile sees the complete approved set, honestly applied).
    // Pre-upload the store is empty (valid envelope, zero records) — the
    // pre-upload baseline census then scopes to the empty set.
    const EMPTY_PRODUCTS_XML = `<?xml version="1.0" encoding="UTF-8"?>\n<ShopSiteProducts version="15.0"><Products></Products></ShopSiteProducts>`;
    const calls: string[] = [];
    let liveProductsXml = EMPTY_PRODUCTS_XML;
    let pendingUploadXml = '';
    const bodyToText = (body: unknown): string => {
      if (typeof body === 'string') return body;
      if (body instanceof Uint8Array) return new TextDecoder().decode(body);
      if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
      return '';
    };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      calls.push(urlStr);
      const bodyText = bodyToText((init as { body?: unknown } | undefined)?.body);

      if (urlStr.includes('db_xml.cgi')) {
        if (bodyText.includes('dbname=pages')) {
          return new Response(SAMPLE_PAGES_XML, {
            status: 200,
            headers: { 'Content-Type': 'text/xml' },
          });
        }
        return new Response(liveProductsXml, {
          status: 200,
          headers: { 'Content-Type': 'text/xml' },
        });
      }

      if (urlStr.includes('dbupload.cgi')) {
        const marker = 'Content-Type: text/xml\r\n\r\n';
        const start = bodyText.indexOf(marker);
        const end = bodyText.lastIndexOf('\r\n--');
        pendingUploadXml = start >= 0 && end > start ? bodyText.slice(start + marker.length, end) : '';
        return new Response('dbmake.cgi?return_string=abc123token', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }

      if (urlStr.includes('dbmake.cgi')) {
        if (pendingUploadXml) {
          liveProductsXml = pendingUploadXml;
          pendingUploadXml = '';
        }
        return new Response('Database build complete. 1 product added.', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }

      if (urlStr.includes('generate.cgi')) {
        return new Response('Storefront publish completed.', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }

      return new Response('Not found', { status: 404 });
    }) as unknown as typeof fetch;

    // 3. Trigger push-publish
    const app = makeApp();
    const res = await app.request('/api/sync/push-publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changeSetId: changeSet.id }),
    });

    const bodyText = await res.text();
    if (res.status !== 200) {
      console.log('Push-publish error:', res.status, bodyText);
    }
    expect(res.status).toBe(200);
    const body = JSON.parse(bodyText) as { success: boolean; jobId: string; publishCompleted: boolean };
    expect(body.success).toBe(true);
    expect(body.publishCompleted).toBe(true);

    // 4. Verify call order: pages db_xml first, then the pre-upload products
    // census (family baseline scope), upload chain, the fresh products
    // reconcile census, and only then generate.cgi on the reconciled verdict.
    expect(calls.length).toBe(6);
    expect(calls[0]).toContain('db_xml.cgi');
    expect(calls[1]).toContain('db_xml.cgi');
    expect(calls[2]).toContain('dbupload.cgi');
    expect(calls[3]).toContain('dbmake.cgi');
    expect(calls[4]).toContain('db_xml.cgi');
    expect(calls[5]).toContain('generate.cgi');
    // 5. Verify page catalog was activated
    const activeImport = getActivePageImport(workspaceId);
    expect(activeImport).not.toBeNull();
    expect(activeImport?.sourceHash).toBe(sha256Hex(SAMPLE_PAGES_XML));

    // 6. Verify sync job events recorded the preflight step
    const events = listSyncJobEvents(body.jobId);
    const messages = events.map(e => e.message);
    expect(messages.some(m => m.includes('ShopSite Pages preflight verification'))).toBe(true);
    expect(messages.some(m => m.includes('Initial page catalog activated from ShopSite'))).toBe(true);
  });

  it('fails closed and halts product push if Pages preflight fails', async () => {
    // 1. Setup change set
    const changeSet = createChangeSet({
      workspaceId,
      title: 'Failing Push',
      description: 'preflight test failure',
      baseCommit: new GitClient(workspacePath).getHeadHash(),
    });
    const product = createSampleProduct('SKU-200');
    const draftJson = JSON.stringify(product);
    upsertChangeSetItem({
      changeSetId: changeSet.id,
      sku: product.sku,
      operation: 'create',
      draftJson,
      baseJson: null,
      draftHash: sha256Hex(draftJson),
    });
    const approved = approveChangeSet(changeSet.id, workspacePath);
    expect(approved.success).toBe(true);

    // 2. Mock fetch: db_xml.cgi returns 500 error
    let dbuploadCalled = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const urlStr = String(input);
      if (urlStr.includes('db_xml.cgi')) {
        return new Response('ShopSite Server Error', { status: 500 });
      }
      if (urlStr.includes('dbupload.cgi')) {
        dbuploadCalled = true;
        return new Response('OK', { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }) as unknown as typeof fetch;

    // 3. Trigger push-publish
    const app = makeApp();
    const res = await app.request('/api/sync/push-publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changeSetId: changeSet.id }),
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; jobId: string };
    expect(body.error).toContain('ShopSite Pages preflight failed');

    // 4. Assert that dbupload.cgi was NEVER called
    expect(dbuploadCalled).toBe(false);

    // 5. Assert job failed event was recorded
    const events = listSyncJobEvents(body.jobId);
    const messages = events.map(e => e.message);
    expect(messages.some(m => m.includes('ShopSite Pages preflight failed'))).toBe(true);
  });
});
