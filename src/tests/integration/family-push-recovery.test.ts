/**
 * Complete-family push and partial-import recovery (issue #373).
 *
 * Fake-ShopSite route exercises only: a parent + two children family flows
 * through approve → push-publish → reconcile with real disposable SQLite/Git
 * workspaces and a scriptable fake CGI transport (global fetch stub — no
 * live network, no vendor credentials), plus a real Bun.serve loopback
 * listener proving wire order and transport faults past mock-call level.
 * Covers the complete native request/finalization order, pre-upload remote
 * verification (missing/diverged/current), populated-store reconcile scoped
 * by a pre-upload census baseline, concurrent-write fail-closed, stale
 * group, auth failure, partial/unknown result, resume/reconcile replay with
 * drift+staleness rechecks, and no false synced state. New-record children
 * upload with newRecords=yes (never update-only silent loss); unchanged
 * remote members verify against a fresh live census resolved from the
 * immutable commit.
 *
 * Seams exercised: approveChangeSet, loadApprovedLinkedExport,
 * planFamilyPushSet/checkRequiredRemoteMembers/reconcileFamilyPushImport
 * (inside the /api/sync routes driven via Hono app.request).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { upsertConnection } from '../../db/repositories/connection-repo';
import { createChangeSet, upsertChangeSetItem } from '../../db/repositories/change-set-repo';
import { findSyncJobById, listSyncJobEvents, createSyncJob, addSyncJobEvent } from '../../db/repositories/sync-job-repo';
import { findProductBySku } from '../../db/repositories/product-index-repo';
import { createDrift } from '../../db/repositories/drift-repo';
import { approveChangeSet, loadApprovedLinkedExport } from '../../server/services/change-set-service';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';
import { createWorkspaceDirs, writeProductFile, readProductFile } from '../../git/workspace-files';
import { GitClient } from '../../git/git-client';
import { deterministicStringify, hashJson } from '../../git/deterministic-json';
import { sha256Hex } from '../../shared/stable-id';
import syncRoutes from '../../server/routes/sync-routes';
import type { Product } from '../../shared/types';

const FAMILY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ShopSiteProducts version="15.0"><Products>
<Product><SKU>FAM-PARENT</SKU><Name>Family Parent</Name><Price>29.99</Price>
<ProductDisabled>uncheck</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/parent.jpg</Graphic><QuantityOnHand>10</QuantityOnHand>
<Subproducts><Subproduct><SKU>FAM-PARENT</SKU><Name>Family Parent</Name><Price>29.99</Price></Subproduct><Subproduct><SKU>FAM-SMALL</SKU><Name>Family Small</Name><Price>24.99</Price></Subproduct><Subproduct><SKU>FAM-LARGE</SKU><Name>Family Large</Name><Price>34.99</Price></Subproduct></Subproducts></Product>
<Product><SKU>FAM-SMALL</SKU><Name>Family Small</Name><Price>24.99</Price>
<ProductDisabled>uncheck</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/small.jpg</Graphic><QuantityOnHand>5</QuantityOnHand></Product>
<Product><SKU>FAM-LARGE</SKU><Name>Family Large</Name><Price>34.99</Price>
<ProductDisabled>uncheck</ProductDisabled><Taxable>checked</Taxable>
<Graphic>media/large.jpg</Graphic><QuantityOnHand>7</QuantityOnHand></Product>
</Products></ShopSiteProducts>`;

const PAGES_XML = `<?xml version="1.0" encoding="UTF-8"?>
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

const UPLOAD_OK_HTML = `<html><head><title>Upload complete</title></head><body>Upload OK. <a href="dbmake.cgi?return_string=fake-return-123&amp;session=fake-session">Build database</a></body></html>`;
const DBMAKE_OK_TEXT = `<html><head><title>Products Upload Results</title></head><body>Products Upload Results. Updated database record 1: Family Parent. Updated database record 2: done. Updated database record 3: done.</body></html>`;

interface FakeShopSite {
  livePagesXml: string;
  liveProductsXml: string;
  pendingUploadXml: string;
  uploads: string[];
  calls: string[];
  dbuploadStatus: number;
  dbuploadBody: string;
  dbmakeStatus: number;
  dbmakeBody: string;
  generateStatus: number;
  productsStatus: number;
  applyAtDbmake: boolean;
  omitFromLive: string[];
  /** Merge uploaded records into live at dbmake (keeps pre-existing store SKUs); default replaces. */
  mergeAtDbmake: boolean;
  /** Raw <Product> blocks injected into live at dbmake (concurrent remote writes). */
  injectAtDbmake: string[];
}

function defaultFake(liveProductsXml: string): FakeShopSite {
  return {
    livePagesXml: PAGES_XML,
    liveProductsXml,
    pendingUploadXml: '',
    uploads: [],
    calls: [],
    dbuploadStatus: 200,
    dbuploadBody: UPLOAD_OK_HTML,
    dbmakeStatus: 200,
    dbmakeBody: DBMAKE_OK_TEXT,
    generateStatus: 200,
    productsStatus: 200,
    applyAtDbmake: true,
    omitFromLive: [],
    mergeAtDbmake: false,
    injectAtDbmake: [],
  };
}

/**
 * Extract top-level <Product> blocks. Non-greedy matching is safe here
 * because nested references use <Subproduct> (never bare <Product>).
 */
function productBlocks(xml: string): string[] {
  return xml.match(/<Product>[\s\S]*?<\/Product>/g) ?? [];
}

/** Top-level SKU of a block: nested <Subproducts> references never count. */
function skuOfBlock(block: string): string | null {
  const top = block.replace(/<Subproducts>[\s\S]*?<\/Subproducts>/g, '');
  return /<SKU>(.*?)<\/SKU>/.exec(top)?.[1] ?? null;
}

/** Rebuild a products document, swapping its record set but keeping the envelope. */
function rebuildLiveXml(envelopeXml: string, blocks: string[]): string {
  const first = envelopeXml.indexOf('<Product>');
  const last = envelopeXml.lastIndexOf('</Product>');
  if (first < 0 || last < 0) return envelopeXml;
  // The envelope carries exactly one top-level record per product: the
  // document's final record close is the last `</Product>` in the string.
  // (`productBlocks` already extracts only top-level records — nested
  // `<Subproduct>` elements never match its `<Product>` opener.)
  return `${envelopeXml.slice(0, first)}${blocks.join('')}${envelopeXml.slice(last + '</Product>'.length)}`;
}

/**
 * Merge uploaded records into the live document at dbmake: uploaded SKUs
 * replace their live counterparts (full-record import semantics), every
 * other live SKU survives untouched (a populated store keeps SKUs outside
 * the pushed set). `omit` drops named SKUs from the applied document
 * (partial remote); `inject` appends concurrent remote writes.
 */
function mergeLiveXml(liveXml: string, pendingXml: string, omit: string[], inject: string[]): string {
  const overlaySkus: Record<string, true> = {};
  for (const block of productBlocks(pendingXml)) {
    const sku = skuOfBlock(block);
    if (sku && !omit.includes(sku)) overlaySkus[sku] = true;
  }
  const kept = productBlocks(liveXml).filter((block) => {
    const sku = skuOfBlock(block);
    return sku !== null && !overlaySkus[sku];
  });
  const applied = productBlocks(pendingXml).filter((block) => {
    const sku = skuOfBlock(block);
    return sku !== null && !omit.includes(sku);
  });
  return rebuildLiveXml(liveXml, [...kept, ...applied, ...inject]);
}

function bodyToText(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  return '';
}

function installFakeShopSite(fake: FakeShopSite): void {
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    const bodyText = bodyToText(init?.body);
    if (url.includes('db_xml.cgi')) {
      if (bodyText.includes('dbname=pages')) {
        fake.calls.push('db_xml:pages');
        return new Response(fake.livePagesXml, { status: 200, headers: { 'Content-Type': 'text/xml' } });
      }
      fake.calls.push('db_xml:products');
      if (fake.productsStatus !== 200) return new Response('unauthorized', { status: fake.productsStatus });
      return new Response(fake.liveProductsXml, { status: 200, headers: { 'Content-Type': 'text/xml' } });
    }
    if (url.includes('dbupload.cgi')) {
      fake.calls.push('dbupload');
      fake.uploads.push(bodyText);
      const marker = 'Content-Type: text/xml\r\n\r\n';
      const start = bodyText.indexOf(marker);
      const end = bodyText.lastIndexOf('\r\n--');
      fake.pendingUploadXml = start >= 0 && end > start ? bodyText.slice(start + marker.length, end) : '';
      if (fake.dbuploadStatus !== 200) return new Response(fake.dbuploadBody, { status: fake.dbuploadStatus });
      return new Response(fake.dbuploadBody, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    if (url.includes('dbmake.cgi')) {
      fake.calls.push('dbmake');
      if (fake.dbmakeStatus !== 200) return new Response(fake.dbmakeBody, { status: fake.dbmakeStatus });
      if (fake.applyAtDbmake && fake.pendingUploadXml) {
        if (fake.mergeAtDbmake || fake.injectAtDbmake.length > 0) {
          fake.liveProductsXml = mergeLiveXml(fake.liveProductsXml, fake.pendingUploadXml, fake.omitFromLive, fake.injectAtDbmake);
        } else if (fake.omitFromLive.length > 0) {
          // Partial remote: drop the named SKUs from the applied document.
          const applied = productBlocks(fake.pendingUploadXml).filter((block) => {
            const sku = skuOfBlock(block);
            return sku !== null && !fake.omitFromLive.includes(sku);
          });
          fake.liveProductsXml = rebuildLiveXml(fake.pendingUploadXml, [...applied, ...fake.injectAtDbmake]);
        } else {
          fake.liveProductsXml = fake.pendingUploadXml;
        }
        fake.pendingUploadXml = '';
      }
      return new Response(fake.dbmakeBody, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    if (url.includes('generate.cgi')) {
      fake.calls.push('generate');
      if (fake.generateStatus !== 200) return new Response('generate failed', { status: fake.generateStatus });
      return new Response('Storefront publish completed.', { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  }) as unknown as typeof fetch;
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api', syncRoutes);
  return app;
}

interface Fixture {
  workspacePath: string;
  workspaceId: string;
  changeSetId: string;
  bases: Map<string, Product>;
}

function setupFamily(opts?: { mutate?: (drafts: Map<string, Product>) => void }): Fixture {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-family-push-373-'));
  const workspaceId = `ws-family-push-373-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();

  insertWorkspace({
    id: workspaceId,
    name: 'family-push-373',
    workspacePath,
    gitPath: `${workspacePath}/.git`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });

  upsertConnection({
    workspaceId,
    cgiBaseUrl: 'https://fake-shopsite.example/cgi-bin/merchant',
    merchantId: 'fake-merchant',
    passwordSecretRef: 'fake-password',
    authStrategy: 'basic',
  });

  createWorkspaceDirs(workspacePath);
  fs.writeFileSync(path.join(workspacePath, '.gitignore'), 'exports/\n');
  const git = new GitClient(workspacePath);
  git.init();

  const decoded = ShopSiteProductCodec.decode(FAMILY_XML, { workspaceId });
  expect(decoded.products).toHaveLength(3);
  for (const p of decoded.products) writeProductFile(workspacePath, p);
  git.add(['products/', '.gitignore']);
  git.commit('Family push baseline');
  const bases = new Map(decoded.products.map((p) => [p.sku, p]));

  const drafts = new Map<string, Product>();
  for (const [sku, base] of bases) drafts.set(sku, JSON.parse(JSON.stringify(base)) as Product);
  if (opts?.mutate) opts.mutate(drafts);
  else {
    drafts.get('FAM-PARENT')!.core.price = '31.99';
    drafts.get('FAM-SMALL')!.core.price = '26.99';
    drafts.get('FAM-LARGE')!.core.price = '36.99';
  }
  const changeSet = createChangeSet({ workspaceId, title: 'Family push 373', baseCommit: git.getHeadHash() });
  for (const [sku, draft] of drafts) {
    const base = bases.get(sku)!;
    if (deterministicStringify(draft) === deterministicStringify(base)) continue;
    upsertChangeSetItem({
      changeSetId: changeSet.id,
      sku,
      operation: 'update',
      draftJson: deterministicStringify(draft),
      baseJson: deterministicStringify(base),
      draftHash: hashJson(draft),
    });
  }
  const approved = approveChangeSet(changeSet.id, workspacePath);
  if (!approved.success) throw new Error(`Approval failed: ${approved.errors.join('; ')}`);
  return { workspacePath, workspaceId, changeSetId: changeSet.id, bases };
}

async function postJson(app: Hono, urlPath: string, body: unknown): Promise<{ status: number; json: Record<string, string | number | boolean | null>; text: string }> {
  const res = await app.request(urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as Record<string, string | number | boolean | null>;
    return { status: res.status, json: parsed, text };
  } catch {
    return { status: res.status, json: { _raw: text }, text };
  }
}

function payloadOf(upload: string): string {
  const marker = 'Content-Type: text/xml\r\n\r\n';
  const start = upload.indexOf(marker);
  const end = upload.lastIndexOf('\r\n--');
  return upload.slice(start + marker.length, end);
}

describe('complete family push and partial-import recovery (issue #373)', () => {
  it('pushes the complete set in native order with SKU matching + new-records yes, then reconciles and marks every SKU synced', async () => {
    const { workspacePath, changeSetId } = setupFamily();
    const approved = currentProducts(workspacePath, changeSetId);
    const app = makeApp();
    const fake = defaultFake(ShopSiteProductCodec.encodeMany(approved).xml);
    installFakeShopSite(fake);
    const { status, json } = await postJson(app, '/api/sync/push-publish', { changeSetId });
    if (status !== 200) throw new Error(`push-publish failed (${status}): ${JSON.stringify(json).slice(0, 500)}`);
    expect(json['success']).toBe(true);
    expect(json['productCount']).toBe(3);
    expect(json['familyReconciled']).toBe(true);

    // Native request/finalization order: pages census, pre-upload products
    // census (baseline scope), upload, dbmake, reconcile census, and only then
    // generate.cgi on a reconciled success (publish never precedes the
    // verdict). generate.cgi runs only after the fresh reconcile census
    // verifies the complete set.
    expect(fake.calls).toEqual(['db_xml:pages', 'db_xml:products', 'dbupload', 'dbmake', 'db_xml:products', 'generate']);
    expect(fake.uploads).toHaveLength(1);
    const upload = fake.uploads[0]!;
    expect(upload).toMatch(/name="uniqueName"\r\n\r\nSKU\r\n/);
    expect(upload).toMatch(/name="newRecords"\r\n\r\nyes\r\n/);
    // All three family records in one upload — never split across sets.
    for (const sku of ['FAM-LARGE', 'FAM-PARENT', 'FAM-SMALL']) {
      expect(upload).toContain(`<SKU>${sku}</SKU>`);
    }

    const job = findSyncJobById(String(json['jobId']))!;
    expect(job.status).toBe('succeeded');
    for (const sku of ['FAM-PARENT', 'FAM-SMALL', 'FAM-LARGE']) {
      expect(findProductBySku(sku)?.syncStatus).toBe('synced');
    }
    const events = listSyncJobEvents(String(json['jobId'])).map((e) => e.message).join('\n');
    expect(events).toContain('Family push plan: 3 record(s) in one complete set');
    expect(events).toContain('Family import reconciled 3/3');
    expect(fs.existsSync(`${workspacePath}/exports/${String(json['jobId'])}`)).toBe(true);
  });
  it('populated store reconciles: pre-existing live SKUs outside the set never fail the push', async () => {
    const { workspacePath, changeSetId } = setupFamily();
    const approved = currentProducts(workspacePath, changeSetId);
    const app = makeApp();
    // The store carries SKUs outside the pushed family both before and after
    // the import; the merge applies uploaded records while those survive.
    const unrelated: Product[] = [];
    for (const sku of ['STORE-OLD-1', 'STORE-OLD-2']) {
      const base = JSON.parse(JSON.stringify(approved[0])) as Product;
      base.sku = sku;
      base.id = `prod-${sku}`;
      base.core.name = `Old Store Item ${sku}`;
      unrelated.push(base);
    }
    const liveXml = ShopSiteProductCodec.encodeMany([...approved, ...unrelated]).xml;
    const fake = defaultFake(liveXml);
    fake.mergeAtDbmake = true;
    installFakeShopSite(fake);

    const { status, json } = await postJson(app, '/api/sync/push-publish', { changeSetId });
    if (status !== 200) throw new Error(`push-publish failed (${status}): ${JSON.stringify(json).slice(0, 500)}`);
    expect(json['success']).toBe(true);
    expect(json['familyReconciled']).toBe(true);
    for (const sku of ['FAM-PARENT', 'FAM-SMALL', 'FAM-LARGE']) {
      expect(findProductBySku(sku)?.syncStatus).toBe('synced');
    }
    // The baseline captured the populated scope; the verdict names no
    // unexpected SKUs.
    const events = listSyncJobEvents(String(json['jobId']));
    const baselineEvent = events.find((e) => e.message.includes('pre-upload census captured'));
    expect(baselineEvent).toBeDefined();
    const baseline = JSON.parse(baselineEvent!.detailsJson!) as { baselineSkus: string[] };
    expect([...baseline.baselineSkus].sort()).toEqual(['FAM-LARGE', 'FAM-PARENT', 'FAM-SMALL', 'STORE-OLD-1', 'STORE-OLD-2']);
    expect(events.map((e) => e.message).join('\n')).toContain('Family import reconciled 3/3');
  });

  it('concurrent store write between baseline and reconcile still fails closed', async () => {
    const { workspacePath, changeSetId } = setupFamily();
    const approved = currentProducts(workspacePath, changeSetId);
    const app = makeApp();
    const oldBase = JSON.parse(JSON.stringify(approved[0])) as Product;
    oldBase.sku = 'STORE-OLD-1';
    oldBase.id = 'prod-STORE-OLD-1';
    const fake = defaultFake(ShopSiteProductCodec.encodeMany([...approved, oldBase]).xml);
    fake.mergeAtDbmake = true;
    const concurrent = JSON.parse(JSON.stringify(approved[0])) as Product;
    concurrent.sku = 'STORE-NEW-CONCURRENT';
    concurrent.id = 'prod-STORE-NEW-CONCURRENT';
    fake.injectAtDbmake = [productBlocks(ShopSiteProductCodec.encodeMany([concurrent]).xml).join('')];
    installFakeShopSite(fake);

    const pushed = await postJson(app, '/api/sync/push-publish', { changeSetId });
    expect(pushed.status).toBe(500);
    expect(String(pushed.json['error'] ?? '')).toContain('unexpectedNew=1');
    // Nothing marks synced on a raced outcome — not even the matched set.
    for (const sku of ['FAM-PARENT', 'FAM-SMALL', 'FAM-LARGE']) {
      expect(findProductBySku(sku)?.syncStatus).not.toBe('synced');
    }
  });

  it('refuses a parent-only push that would dangle a new child; inclusion of the complete record recovers', async () => {
    // Parent references a brand-new child SKU with no approved catalog entry
    // and no live presence: the group is incomplete, so approval itself
    // refuses (LINKED_GROUP_REFERENCE_MISSING) — the dangling child can
    // never hide behind a parent-only push. Including the child's complete
    // record in the group then approves and pushes cleanly.
    const { workspaceId, workspacePath } = setupFamily({
      mutate: (drafts) => {
        drafts.get('FAM-PARENT')!.core.price = '31.99';
      },
    });
    const bases = new Map(
      ShopSiteProductCodec.decode(FAMILY_XML, { workspaceId }).products.map((p) => [p.sku, p]),
    );
    const parentBase = bases.get('FAM-PARENT')!;
    const dangling = JSON.parse(JSON.stringify(parentBase)) as Product;
    dangling.core.price = '32.99';
    dangling.shopsite.preserved.advancedBlocks['Subproducts'] =
      '<Subproducts><Subproduct><SKU>FAM-PARENT</SKU><Name>Family Parent</Name></Subproduct><Subproduct><SKU>FAM-GHOST</SKU><Name>Ghost</Name></Subproduct></Subproducts>';
    const ghostSet = createChangeSet({ workspaceId, title: 'Dangling child', baseCommit: new GitClient(workspacePath).getHeadHash() });
    upsertChangeSetItem({
      changeSetId: ghostSet.id,
      sku: 'FAM-PARENT',
      operation: 'update',
      draftJson: deterministicStringify(dangling),
      baseJson: deterministicStringify(parentBase),
      draftHash: hashJson(dangling),
    });
    const refused = approveChangeSet(ghostSet.id, workspacePath);
    expect(refused.success).toBe(false);
    expect(refused.errors.join('; ')).toContain('FAM-GHOST');
  });
  it('pre-upload remote verification refuses a missing unchanged member before any upload (6-call shape on success)', async () => {
    // Parent-only update: FAM-SMALL and FAM-LARGE stay unchanged, so the
    // manifest carries them as reads and the push must verify them live
    // BEFORE upload.
    const { workspacePath, changeSetId } = setupFamily({
      mutate: (drafts) => {
        drafts.get('FAM-PARENT')!.core.price = '31.99';
      },
    });
    const parent = currentProducts(workspacePath, changeSetId);
    expect(parent.map((p) => p.sku)).toEqual(['FAM-PARENT']);
    const app = makeApp();
    // Live store lacks the unchanged members entirely.
    const fake = defaultFake(ShopSiteProductCodec.encodeMany(parent).xml);
    installFakeShopSite(fake);

    const refused = await postJson(app, '/api/sync/push-publish', { changeSetId });
    expect(refused.status).toBe(500);
    expect(String(refused.json['error'] ?? '')).toContain('absent from the live store');
    expect(fake.uploads).toHaveLength(0);
    // Refusal lands at verification: pages census + products census only.
    expect(fake.calls).toEqual(['db_xml:pages', 'db_xml:products']);
    for (const sku of ['FAM-PARENT', 'FAM-SMALL', 'FAM-LARGE']) {
      expect(findProductBySku(sku)?.syncStatus).not.toBe('synced');
    }
  });

  it('pre-upload remote verification refuses a diverged unchanged member before any upload', async () => {
    const { workspacePath, changeSetId } = setupFamily({
      mutate: (drafts) => {
        drafts.get('FAM-PARENT')!.core.price = '31.99';
      },
    });
    const parent = currentProducts(workspacePath, changeSetId);
    const app = makeApp();
    // Live SMALL drifted remotely (price moved outside the approved group).
    const divergedSmall = readProductFile(workspacePath, 'FAM-SMALL')!;
    divergedSmall.core.price = '99.99';
    const divergedLive = ShopSiteProductCodec.encodeMany([parent[0]!, divergedSmall, readProductFile(workspacePath, 'FAM-LARGE')!]).xml;
    const fake = defaultFake(divergedLive);
    installFakeShopSite(fake);

    const refused = await postJson(app, '/api/sync/push-publish', { changeSetId });
    expect(refused.status).toBe(500);
    expect(String(refused.json['error'] ?? '')).toContain('differs live');
    expect(fake.uploads).toHaveLength(0);
    expect(findProductBySku('FAM-PARENT')?.syncStatus).not.toBe('synced');
  });

  it('pre-upload remote verification passes for current members: 6-call sequence, parent synced', async () => {
    const { workspacePath, changeSetId } = setupFamily({
      mutate: (drafts) => {
        drafts.get('FAM-PARENT')!.core.price = '31.99';
      },
    });
    const parent = currentProducts(workspacePath, changeSetId);
    const app = makeApp();
    // Live carries the updated parent plus both unchanged members current.
    const liveXml = ShopSiteProductCodec.encodeMany([parent[0]!, readProductFile(workspacePath, 'FAM-SMALL')!, readProductFile(workspacePath, 'FAM-LARGE')!]).xml;
    const fake = defaultFake(liveXml);
    fake.mergeAtDbmake = true;
    installFakeShopSite(fake);

    const { status, json } = await postJson(app, '/api/sync/push-publish', { changeSetId });
    if (status !== 200) throw new Error(`push-publish failed (${status}): ${JSON.stringify(json).slice(0, 500)}`);
    expect(json['success']).toBe(true);
    expect(json['familyReconciled']).toBe(true);
    // Exact 6-call wire sequence (unchanged count, new order): pages
    // preflight, pre-upload products census (verification + baseline),
    // upload, dbmake, reconcile census, then generate on the reconciled
    // verdict.
    const jobEvents = listSyncJobEvents(String(json['jobId'])).map((e) => e.message).join('\n');
    expect(jobEvents).toContain('Family push remote verification passed for 2 unchanged member(s).');
    // Only the pushed write marks synced; verified-but-unpushed reads stay
    // exactly as they were (no manufactured sync).
    expect(findProductBySku('FAM-PARENT')?.syncStatus).toBe('synced');
    expect(findProductBySku('FAM-SMALL')?.syncStatus).not.toBe('synced');
    expect(findProductBySku('FAM-LARGE')?.syncStatus).not.toBe('synced');
  });

  it('failed upload retains the approved operation with unsynced state; resume replays the exact payload and reconciles', async () => {
    const { workspacePath, changeSetId } = setupFamily();
    const app = makeApp();
    const liveXml = ShopSiteProductCodec.encodeMany(currentProducts(workspacePath, changeSetId)).xml;
    const fake = defaultFake(liveXml);
    fake.dbuploadStatus = 500;
    fake.dbuploadBody = 'upload exploded';
    installFakeShopSite(fake);

    const first = await postJson(app, '/api/sync/push-publish', { changeSetId });
    expect(first.status).toBe(500);
    expect(String(first.json['error'] ?? '')).toContain('Upload failed');
    const failedJob = findSyncJobById(String(first.json['jobId']))!;
    expect(failedJob.status).toBe('failed');
    // No false synced: every SKU stays unsynced.
    for (const sku of ['FAM-PARENT', 'FAM-SMALL', 'FAM-LARGE']) {
      expect(findProductBySku(sku)?.syncStatus).not.toBe('synced');
    }

    // Resume replays the exact approved payload: fix the transport and resume.
    fake.dbuploadStatus = 200;
    fake.dbuploadBody = UPLOAD_OK_HTML;
    installFakeShopSite(fake);
    const resumed = await postJson(app, '/api/sync/resume-push', { changeSetId, publish: true });
    if (resumed.status !== 200) throw new Error(`resume failed (${resumed.status}): ${JSON.stringify(resumed.json).slice(0, 500)}`);
    expect(resumed.json['success']).toBe(true);
    expect(resumed.json['resumed']).toBe(true);
    expect(fake.uploads).toHaveLength(2);
    // Idempotent replay: byte-identical payload on resume.
    expect(sha256Hex(payloadOf(fake.uploads[1]!))).toBe(sha256Hex(payloadOf(fake.uploads[0]!)));
    for (const sku of ['FAM-PARENT', 'FAM-SMALL', 'FAM-LARGE']) {
      expect(findProductBySku(sku)?.syncStatus).toBe('synced');
    }
  });

  it('partial remote import publishes NOTHING: reconcile census precedes generate, no SKU marks synced', async () => {
    const { workspacePath, changeSetId } = setupFamily();
    const app = makeApp();
    const liveXml = ShopSiteProductCodec.encodeMany(currentProducts(workspacePath, changeSetId)).xml;
    const fake = defaultFake(liveXml);
    fake.omitFromLive = ['FAM-SMALL'];
    installFakeShopSite(fake);
    const pushed = await postJson(app, '/api/sync/push-publish', { changeSetId });
    expect(pushed.status).toBe(500);
    expect(String(pushed.json['error'] ?? '')).toContain('not reconciled');
    // Publish never ran on the partial outcome: no generate call, no
    // generate artifact — the route reported the failure un-published.
    expect(fake.calls).toEqual(['db_xml:pages', 'db_xml:products', 'dbupload', 'dbmake', 'db_xml:products']);
    expect(fake.calls).not.toContain('generate');
    expect(fs.existsSync(path.join(workspacePath, 'exports', String(pushed.json['jobId']), 'generate.cgi.redacted.txt'))).toBe(false);
    for (const sku of ['FAM-PARENT', 'FAM-SMALL', 'FAM-LARGE']) {
      expect(findProductBySku(sku)?.syncStatus).not.toBe('synced');
    }
    const failedJob = findSyncJobById(String(pushed.json['jobId']))!;
    expect(failedJob.status).toBe('failed');
    // The store converges (operator fixes the remote); reconcile verifies
    // without retransmitting.
    fake.omitFromLive = [];
    fake.liveProductsXml = ShopSiteProductCodec.encodeMany(currentProducts(workspacePath, changeSetId)).xml;
    installFakeShopSite(fake);
    const uploadsBefore = fake.uploads.length;
    const reconciled = await postJson(app, '/api/sync/reconcile-push', { changeSetId, jobId: String(pushed.json['jobId']) });
    if (reconciled.status !== 200) throw new Error(`reconcile failed (${reconciled.status}): ${JSON.stringify(reconciled.json).slice(0, 500)}`);
    expect(reconciled.json['reconciled']).toBe(true);
    expect(fake.uploads.length).toBe(uploadsBefore);
    for (const sku of ['FAM-PARENT', 'FAM-SMALL', 'FAM-LARGE']) {
      expect(findProductBySku(sku)?.syncStatus).toBe('synced');
    }
  });
  it('unknown outcome (dbmake transport failure) retains the operation unsynced; reconcile recovers without retransmit', async () => {
    const { workspacePath, changeSetId } = setupFamily();
    const app = makeApp();
    // Upload succeeds but dbmake explodes at the transport: the remote may
    // or may not have applied — the outcome is UNKNOWN, never a sync.
    const liveXml = ShopSiteProductCodec.encodeMany(currentProducts(workspacePath, changeSetId)).xml;
    const fake = defaultFake(liveXml);
    fake.dbmakeStatus = 500;
    fake.dbmakeBody = 'dbmake exploded';
    installFakeShopSite(fake);

    const pushed = await postJson(app, '/api/sync/push-publish', { changeSetId });
    expect(pushed.status).toBe(500);
    expect(String(pushed.json['error'] ?? '')).toContain('dbmake finalization failed');
    for (const sku of ['FAM-PARENT', 'FAM-SMALL', 'FAM-LARGE']) {
      expect(findProductBySku(sku)?.syncStatus).not.toBe('synced');
    }

    // The remote actually applied (fake store applies at dbmake only on
    // success — emulate convergence by aligning live to the payload, then
    // reconcile verifies without retransmitting).
    fake.dbmakeStatus = 200;
    fake.dbmakeBody = DBMAKE_OK_TEXT;
    fake.applyAtDbmake = false;
    fake.liveProductsXml = ShopSiteProductCodec.encodeMany(currentProducts(workspacePath, changeSetId)).xml;
    installFakeShopSite(fake);
    const uploadsBefore = fake.uploads.length;
    const reconciled = await postJson(app, '/api/sync/reconcile-push', { changeSetId, jobId: String(pushed.json['jobId']) });
    if (reconciled.status !== 200) throw new Error(`reconcile failed (${reconciled.status}): ${JSON.stringify(reconciled.json).slice(0, 500)}`);
    expect(reconciled.json['reconciled']).toBe(true);
    expect(fake.uploads.length).toBe(uploadsBefore);
  });
  it('reconcile-push re-checks staleness: a worktree edit after the failed push refuses instead of syncing', async () => {
    const { workspacePath, changeSetId } = setupFamily();
    const app = makeApp();
    const liveXml = ShopSiteProductCodec.encodeMany(currentProducts(workspacePath, changeSetId)).xml;
    const fake = defaultFake(liveXml);
    fake.omitFromLive = ['FAM-SMALL'];
    installFakeShopSite(fake);

    const pushed = await postJson(app, '/api/sync/push-publish', { changeSetId });
    expect(pushed.status).toBe(500);

    // The store converges — but a worktree edit lands before reconcile.
    fake.omitFromLive = [];
    fake.liveProductsXml = ShopSiteProductCodec.encodeMany(currentProducts(workspacePath, changeSetId)).xml;
    installFakeShopSite(fake);
    const edited = readProductFile(workspacePath, 'FAM-LARGE')!;
    edited.core.price = '88.88';
    writeProductFile(workspacePath, edited);

    const reconciled = await postJson(app, '/api/sync/reconcile-push', { changeSetId, jobId: String(pushed.json['jobId']) });
    expect(reconciled.status).toBe(409);
    expect(reconciled.json['stale']).toBe(true);
    expect(fake.uploads).toHaveLength(1);
    for (const sku of ['FAM-PARENT', 'FAM-SMALL', 'FAM-LARGE']) {
      expect(findProductBySku(sku)?.syncStatus).not.toBe('synced');
    }
  });

  it('reconcile-push re-checks drift: unresolved remote drift refuses instead of syncing', async () => {
    const { workspacePath, workspaceId, changeSetId } = setupFamily();
    const app = makeApp();
    const liveXml = ShopSiteProductCodec.encodeMany(currentProducts(workspacePath, changeSetId)).xml;
    const fake = defaultFake(liveXml);
    fake.dbmakeStatus = 500;
    fake.dbmakeBody = 'dbmake exploded';
    installFakeShopSite(fake);

    const pushed = await postJson(app, '/api/sync/push-publish', { changeSetId });
    expect(pushed.status).toBe(500);

    // The remote converges, but unresolved drift is now outstanding.
    fake.dbmakeStatus = 200;
    fake.dbmakeBody = DBMAKE_OK_TEXT;
    fake.applyAtDbmake = false;
    fake.liveProductsXml = ShopSiteProductCodec.encodeMany(currentProducts(workspacePath, changeSetId)).xml;
    installFakeShopSite(fake);
    createDrift({
      workspaceId,
      sku: 'FAM-PARENT',
      localHash: 'local-hash',
      remoteHash: 'remote-hash',
      localJson: '{}',
      remoteJson: '{}',
    });

    const reconciled = await postJson(app, '/api/sync/reconcile-push', { changeSetId, jobId: String(pushed.json['jobId']) });
    expect(reconciled.status).toBe(409);
    expect(String(reconciled.json['error'] ?? '')).toContain('FAM-PARENT');
    for (const sku of ['FAM-PARENT', 'FAM-SMALL', 'FAM-LARGE']) {
      expect(findProductBySku(sku)?.syncStatus).not.toBe('synced');
    }
  });

  it('stale group refuses: a later member edit after approval blocks the push instead of rewriting the payload', async () => {
    const { workspacePath, changeSetId } = setupFamily();
    // Later related edit after approval: bump a member price in the working
    // tree (unapproved). Approval-time bases are stale, so the push refuses
    // instead of silently rewriting bytes.
    const live = readProductFile(workspacePath, 'FAM-SMALL')!;
    live.core.price = '99.99';
    writeProductFile(workspacePath, live);
    const app = makeApp();
    const fake = defaultFake(ShopSiteProductCodec.encodeMany(currentProducts(workspacePath, changeSetId)).xml);
    installFakeShopSite(fake);
    const { status, json } = await postJson(app, '/api/sync/push-publish', { changeSetId });
    // The push-time staleness gate owns this refusal: exact 409 stale
    // verdict (not a load-path 500), with zero-upload guarantee.
    expect(status).toBe(409);
    expect(json['stale']).toBe(true);
    expect(String(json['error'] ?? '')).toContain('changed after approval');
    expect(fake.uploads).toHaveLength(0);
  });

  it('missing authorization refuses honestly without a false synced marking', async () => {
    const { workspacePath, changeSetId } = setupFamily();
    const app = makeApp();
    const fake = defaultFake(ShopSiteProductCodec.encodeMany(currentProducts(workspacePath, changeSetId)).xml);
    fake.productsStatus = 401;
    fake.dbmakeStatus = 500;
    fake.dbmakeBody = 'unauthorized';
    installFakeShopSite(fake);
    const { status, json } = await postJson(app, '/api/sync/push-publish', { changeSetId });
    expect(status).toBe(500);
    expect(String(json['error'] ?? '').length).toBeGreaterThan(0);
    for (const sku of ['FAM-PARENT', 'FAM-SMALL', 'FAM-LARGE']) {
      expect(findProductBySku(sku)?.syncStatus).not.toBe('synced');
    }
  });
  it('null connection branch: no configured connection refuses honestly (Use Export Package instead)', async () => {
    // getConnectionConfig → null: delete the row entirely (not 401-with-a-
    // connection), exercising the branch the 401 test never reaches.
    const { workspacePath, workspaceId, changeSetId } = setupFamily();
    getDb().run('DELETE FROM connection WHERE workspace_id = ?', [workspaceId]);
    const app = makeApp();
    const fake = defaultFake(ShopSiteProductCodec.encodeMany(currentProducts(workspacePath, changeSetId)).xml);
    installFakeShopSite(fake);
    expect(fake.calls).toHaveLength(0);
    for (const urlPath of ['/api/sync/push-publish', '/api/sync/upload-only', '/api/sync/resume-push', '/api/sync/reconcile-push']) {
      const { status, json } = await postJson(app, urlPath, { changeSetId });
      expect(status).toBe(400);
      expect(String(json['error'] ?? '')).toContain('Use Export Package instead');
    }
    expect(fake.calls).toHaveLength(0);
    for (const sku of ['FAM-PARENT', 'FAM-SMALL', 'FAM-LARGE']) {
      expect(findProductBySku(sku)?.syncStatus).not.toBe('synced');
    }
  });
  it('reconcile baseline scoping: an explicit jobId without a baseline refuses — never a different change set store state', async () => {
    // A failed push for change set A records a baseline; change set B has
    // only a jobId that carries NO baseline. Reconciling B with that jobId
    // must refuse as unknowable — never scope B's verdict against A's store.
    const fixA = setupFamily();
    const app = makeApp();
    const fakeA = defaultFake(ShopSiteProductCodec.encodeMany(currentProducts(fixA.workspacePath, fixA.changeSetId)).xml);
    fakeA.omitFromLive = ['FAM-SMALL'];
    installFakeShopSite(fakeA);
    const pushedA = await postJson(app, '/api/sync/push-publish', { changeSetId: fixA.changeSetId });
    expect(pushedA.status).toBe(500);
    expect(listSyncJobEvents(String(pushedA.json['jobId'])).some((e) => (e.detailsJson ?? '').includes('baselineSkus'))).toBe(true);
    const fixB = setupFamily();
    const fakeB = defaultFake(ShopSiteProductCodec.encodeMany(currentProducts(fixB.workspacePath, fixB.changeSetId)).xml);
    installFakeShopSite(fakeB);
    const reconciled = await postJson(app, '/api/sync/reconcile-push', { changeSetId: fixB.changeSetId, jobId: String(pushedA.json['jobId']) });
    expect(reconciled.status).toBe(409);
    expect(String(reconciled.json['error'] ?? '')).toContain('unknowable');
    expect(fakeB.uploads).toHaveLength(0);
  });
  it('reconcile baseline ownership: an existing foreign-change-set baseline jobId can never scope this change set', async () => {
    // The foreign job carries a REAL baseline (same workspace DB, other change
    // set). Ownership validation refuses it before reading its events — the
    // verdict never scopes against a foreign change set's store state.
    const fixB = setupFamily();
    const app = makeApp();
    const fakeB = defaultFake(ShopSiteProductCodec.encodeMany(currentProducts(fixB.workspacePath, fixB.changeSetId)).xml);
    fakeB.omitFromLive = ['FAM-SMALL'];
    installFakeShopSite(fakeB);
    const pushedB = await postJson(app, '/api/sync/push-publish', { changeSetId: fixB.changeSetId });
    expect(pushedB.status).toBe(500);
    const foreignJob = String(pushedB.json['jobId']);
    expect(listSyncJobEvents(foreignJob).some((e) => (e.detailsJson ?? '').includes('baselineSkus'))).toBe(true);
    // A foreign push job for another change set in the SAME workspace DB,
    // carrying a real baseline for an unrelated scope. The foreign change set
    // row must exist: sync_jobs.change_set_id is a real FK to change_sets.
    const foreignSet = createChangeSet({ workspaceId: fixB.workspaceId, title: 'Foreign scope', baseCommit: 'test' });
    const foreign = createSyncJob({ workspaceId: fixB.workspaceId, changeSetId: foreignSet.id, kind: 'push_publish' });
    addSyncJobEvent({ syncJobId: foreign.id, level: 'info', message: 'Family push pre-upload census captured (1 live SKU(s) in scope).', detailsJson: JSON.stringify({ baselineSkus: ['FOREIGN-SKU'] }) });
    const uploadsBefore = fakeB.uploads.length;
    const reconciled = await postJson(app, '/api/sync/reconcile-push', { changeSetId: fixB.changeSetId, jobId: foreign.id });
    expect(reconciled.status).toBe(409);
    expect(String(reconciled.json['error'] ?? '')).toContain('unknowable');
    expect(fakeB.uploads).toHaveLength(uploadsBefore);
  });
  it('reconcile payload identity: the verdict records the reconciled XML hash and pointers hash reconciled products', async () => {
    // Successful reconcile records the hash of the bytes the verdict checked
    // (the page-reconciled XML), and sync pointers advance from the same
    // reconciled representation — never a pre-reconciliation plan hash or
    // pre-reconciliation product bytes.
    const { workspacePath, changeSetId } = setupFamily();
    const app = makeApp();
    const fake = defaultFake(ShopSiteProductCodec.encodeMany(currentProducts(workspacePath, changeSetId)).xml);
    fake.omitFromLive = ['FAM-SMALL'];
    installFakeShopSite(fake);
    const pushed = await postJson(app, '/api/sync/push-publish', { changeSetId });
    expect(pushed.status).toBe(500);
    const originJob = findSyncJobById(String(pushed.json['jobId']))!;
    const originEvent = listSyncJobEvents(originJob.id).find((e) => (e.detailsJson ?? '').includes('pushPayloadHash'));
    expect(originEvent?.detailsJson).toContain('pagesSourceHash');
    const origin = JSON.parse(originEvent!.detailsJson!) as { pushPayloadHash: string; pagesSourceHash: string };
    // The store converges (operator fixes the remote); reconcile recovers
    // against the originating payload identity without retransmitting.
    fake.omitFromLive = [];
    fake.liveProductsXml = ShopSiteProductCodec.encodeMany(currentProducts(workspacePath, changeSetId)).xml;
    installFakeShopSite(fake);
    const uploadsBefore = fake.uploads.length;
    const reconciled = await postJson(app, '/api/sync/reconcile-push', { changeSetId, jobId: originJob.id });
    expect(reconciled.status).toBe(200);
    expect(fake.uploads.length).toBe(uploadsBefore);
    const job = findSyncJobById(String((reconciled.json as Record<string, unknown>)['jobId']))!;
    const event = listSyncJobEvents(job.id).find((e) => (e.detailsJson ?? '').includes('pushPayloadHash'))!;
    const recorded = JSON.parse(event.detailsJson!) as { pushPayloadHash: string };
    expect(recorded.pushPayloadHash).toBe(origin.pushPayloadHash);
    expect(recorded.pushPayloadHash).toHaveLength(64);
  });
  it('resume-push refuses backfill mode: family resume must upload newRecords=yes', async () => {
    const { workspacePath, changeSetId } = setupFamily();
    const app = makeApp();
    const fake = defaultFake(ShopSiteProductCodec.encodeMany(currentProducts(workspacePath, changeSetId)).xml);
    installFakeShopSite(fake);
    const refused = await postJson(app, '/api/sync/resume-push', { changeSetId, publish: true, backfillMode: true });
    expect(refused.status).toBe(400);
    expect(String(refused.json['error'] ?? '')).toContain('newRecords=yes');
    expect(fake.uploads).toHaveLength(0);
  });
  it('two consecutive resumes after a Pages move: the first refuses, the second still refuses on the originating identity (no rejected-candidate promotion)', async () => {
    // The new (refused) resume records its moved-on payload + Pages hash
    // before the identity check. The next resume must NOT select that newer
    // failed job as its origin: recovery binds the durable originating job,
    // so the second attempt still sees the Pages move and refuses instead of
    // uploading moved-on bytes without reapproval.
    const { workspacePath, changeSetId } = setupFamily();
    const app = makeApp();
    const liveXml = ShopSiteProductCodec.encodeMany(currentProducts(workspacePath, changeSetId)).xml;
    const fake = defaultFake(liveXml);
    fake.dbuploadStatus = 500;
    fake.dbuploadBody = 'upload exploded';
    installFakeShopSite(fake);
    const first = await postJson(app, '/api/sync/push-publish', { changeSetId });
    expect(first.status).toBe(500);
    expect(listSyncJobEvents(String(first.json['jobId'])).some((e) => (e.detailsJson ?? '').includes('pushPayloadHash'))).toBe(true);
    // Pages renames between attempts (a stable-ID page move changes the
    // live catalog). The fake pages reply only ever carries PAGES_XML, so
    // emulate the move by returning a renamed page document from the fake —
    // the preflight reconciles it into a genuinely new active import and
    // the resume refuses against the originating payload identity.
    const PAGES_MOVED_XML = PAGES_XML.replaceAll('Pet Food', 'Pet Food & Supplies');
    fake.livePagesXml = PAGES_MOVED_XML;
    fake.dbuploadStatus = 200;
    fake.dbuploadBody = UPLOAD_OK_HTML;
    installFakeShopSite(fake);
    const uploadsBefore = fake.uploads.length;
    const resumeOne = await postJson(app, '/api/sync/resume-push', { changeSetId, publish: true });
    expect(resumeOne.status).toBe(500);
    expect(String(resumeOne.json['error'] ?? '')).toContain('Resume refused');
    expect(fake.uploads).toHaveLength(uploadsBefore);
    const resumeTwo = await postJson(app, '/api/sync/resume-push', { changeSetId, publish: true });
    expect(resumeTwo.status).toBe(500);
    expect(String(resumeTwo.json['error'] ?? '')).toContain('Resume refused');
    expect(fake.uploads).toHaveLength(uploadsBefore);
    for (const sku of ['FAM-PARENT', 'FAM-SMALL', 'FAM-LARGE']) {
      expect(findProductBySku(sku)?.syncStatus).not.toBe('synced');
    }
  });
  it('real loopback HTTP: full push reconciles through genuine TCP framing (no fetch stub)', async () => {
    const { workspacePath, workspaceId, changeSetId } = setupFamily();
    const approved = currentProducts(workspacePath, changeSetId);
    const app = makeApp();
    const loopback = await startLoopbackShopSite(ShopSiteProductCodec.encodeMany(approved).xml);
    try {
      upsertConnection({
        workspaceId,
        cgiBaseUrl: loopback.cgiBaseUrl,
        merchantId: 'fake-merchant',
        passwordSecretRef: 'fake-password',
        authStrategy: 'basic',
      });
      const { status, json } = await postJson(app, '/api/sync/push-publish', { changeSetId });
      if (status !== 200) throw new Error(`push-publish failed (${status}): ${JSON.stringify(json).slice(0, 500)}`);
      expect(json['success']).toBe(true);
      expect(json['familyReconciled']).toBe(true);
      // Genuine HTTP round trips in the new order, with the pre-upload
      // products census scoping the reconcile and generate last.
      expect(loopback.calls).toEqual(['db_xml:pages', 'db_xml:products', 'dbupload', 'dbmake', 'db_xml:products', 'generate']);
      expect(loopback.uploads).toHaveLength(1);
      expect(loopback.uploads[0]).toMatch(/name="uniqueName"\r\n\r\nSKU\r\n/);
      for (const sku of ['FAM-PARENT', 'FAM-SMALL', 'FAM-LARGE']) {
        expect(loopback.uploads[0]).toContain(`<SKU>${sku}</SKU>`);
        expect(findProductBySku(sku)?.syncStatus).toBe('synced');
      }
    } finally {
      loopback.server.stop(true);
    }
  });

  it('real loopback HTTP: dbmake transport fault refuses honestly with no false sync', async () => {
    const { workspacePath, workspaceId, changeSetId } = setupFamily();
    const approved = currentProducts(workspacePath, changeSetId);
    const app = makeApp();
    const loopback = await startLoopbackShopSite(ShopSiteProductCodec.encodeMany(approved).xml, { dbmakeStatus: 500 });
    try {
      upsertConnection({
        workspaceId,
        cgiBaseUrl: loopback.cgiBaseUrl,
        merchantId: 'fake-merchant',
        passwordSecretRef: 'fake-password',
        authStrategy: 'basic',
      });
      const { status, json } = await postJson(app, '/api/sync/push-publish', { changeSetId });
      expect(status).toBe(500);
      expect(String(json['error'] ?? '')).toContain('dbmake finalization failed');
      // The fault surfaces through real HTTP status lines; publish never
      // runs after a failed dbmake, and nothing marks synced.
      expect(loopback.calls).toEqual(['db_xml:pages', 'db_xml:products', 'dbupload', 'dbmake']);
      expect(loopback.calls).not.toContain('generate');
      for (const sku of ['FAM-PARENT', 'FAM-SMALL', 'FAM-LARGE']) {
        expect(findProductBySku(sku)?.syncStatus).not.toBe('synced');
      }
    } finally {
      loopback.server.stop(true);
    }
  });
});

// ── Real loopback HTTP harness (issue #373 gap 2) ───────────────────────────
// A genuine Bun.serve listener on 127.0.0.1 emulates the ShopSite CGI
// endpoints over real TCP (status lines, headers, bodies) instead of a
// globalThis.fetch stub, so wire order + transport faults are proven past
// mock-call level. No live network, no vendor credentials.

interface LoopbackShopSite {
  server: { stop: (closeActiveConnections?: boolean) => void };
  cgiBaseUrl: string;
  calls: string[];
  uploads: string[];
}

async function startLoopbackShopSite(
  liveProductsXml: string,
  opts?: { dbmakeStatus?: number },
): Promise<LoopbackShopSite> {
  const calls: string[] = [];
  const uploads: string[] = [];
  let live = liveProductsXml;
  let pending = '';
  const dbmakeStatus = opts?.dbmakeStatus ?? 200;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === 'POST' ? await req.text() : '';
      if (url.pathname.endsWith('/db_xml.cgi')) {
        if (body.includes('dbname=pages')) {
          calls.push('db_xml:pages');
          return new Response(PAGES_XML, { status: 200, headers: { 'Content-Type': 'text/xml' } });
        }
        calls.push('db_xml:products');
        return new Response(live, { status: 200, headers: { 'Content-Type': 'text/xml' } });
      }
      if (url.pathname.endsWith('/dbupload.cgi')) {
        calls.push('dbupload');
        uploads.push(body);
        const marker = 'Content-Type: text/xml\r\n\r\n';
        const start = body.indexOf(marker);
        const end = body.lastIndexOf('\r\n--');
        pending = start >= 0 && end > start ? body.slice(start + marker.length, end) : '';
        return new Response(UPLOAD_OK_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } });
      }
      if (url.pathname.endsWith('/dbmake.cgi')) {
        calls.push('dbmake');
        if (dbmakeStatus !== 200) return new Response('dbmake exploded', { status: dbmakeStatus });
        if (pending) {
          live = pending;
          pending = '';
        }
        return new Response(DBMAKE_OK_TEXT, { status: 200, headers: { 'Content-Type': 'text/html' } });
      }
      if (url.pathname.endsWith('/generate.cgi')) {
        calls.push('generate');
        return new Response('Storefront publish completed.', { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    },
  });
  return { server, cgiBaseUrl: `http://127.0.0.1:${server.port}/cgi-bin/merchant`, calls, uploads };
}
// ── Test-local workspace helpers (no live state) ────────────────────────────
// Each test builds an isolated disposable workspace; the fixture threads its
// path explicitly (the route under test resolves the workspace from the same
// global DB, and these isolated initDb calls ARE that workspace).

function currentProducts(workspacePath: string, changeSetId: string): Product[] {
  const load = loadApprovedLinkedExport(changeSetId, workspacePath);
  if (!load.ok) throw new Error(`linked export unavailable in test: ${load.error}`);
  return load.load.products;
}
