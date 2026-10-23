/**
 * Milestone-1 exit dry run (backfill remediation plan).
 *
 * Fake-ShopSite end-to-end proof only: 14 intended unique top-level products
 * flow through classify (accepted PF23 decisions bound via
 * classification_run_id), approve (scoped commit + verified page joins),
 * gated update-only sync (newRecords=no), reconciliation, and pending
 * publish. No live store changes, no real network, no real credentials.
 *
 * Seams exercised: ShopSiteProductCodec, createRun/submitProposalDecisions,
 * approveChangeSet, preflightBackfill + reconcileBackfillImport (inside the
 * /api/sync routes driven via Hono app.request).
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
import {
  createChangeSet,
  listChangeSetItems,
  upsertChangeSetItem,
} from '../../db/repositories/change-set-repo';
import { createRun, completeRun } from '../../db/repositories/classification-run-repo';
import { generateCandidate } from '../../classification/config-generator';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { buildRuntimeSnapshot, persistRuntimeSnapshot } from '../../classification/runtime-snapshot';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import { submitProposalDecisions } from '../../classification/proposal-review-service';
import { findSyncJobById, listSyncJobEvents } from '../../db/repositories/sync-job-repo';
import { findProductBySku } from '../../db/repositories/product-index-repo';
import {
  getProductPageAssignments,
  getProductPages,
  listVerifiedPageOptions,
} from '../../db/repositories/page-repo';
import { approveChangeSet } from '../../server/services/change-set-service';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';
import { parseBackfillCensusXml } from '../../shopsite/backfill-preflight';
import { reconcileBackfillImport } from '../../shopsite/backfill-reconcile';
import { parseShopSitePagesXml, toPageRecords } from '../../shopsite/page-parser';
import { activatePageImportFromRecords } from '../../shopsite/page-import-service';
import { createWorkspaceDirs, writeProductFile } from '../../git/workspace-files';
import { skuToProductFilePath } from '../../git/product-file-path';
import { GitClient } from '../../git/git-client';
import { deterministicStringify, hashJson } from '../../git/deterministic-json';
import { sha256Hex } from '../../shared/stable-id';
import syncRoutes from '../../server/routes/sync-routes';
import type { Product } from '../../shared/types';

const SKUS = Array.from({ length: 14 }, (_, i) => `M1-${String(i + 1).padStart(4, '0')}`);
const FLAVORS = [
  'Chicken', 'Beef', 'Salmon', 'Lamb', 'Turkey', 'Duck', 'Venison',
  'Bison', 'Pork', 'Whitefish', 'Rabbit', 'Kangaroo', 'Oatmeal', 'Peanut Butter',
];

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
    <Page>
      <PageID>2002</PageID>
      <Name>Dog Supplies</Name>
      <PageFileName>dog-supplies.html</PageFileName>
    </Page>
    <Page>
      <PageID>2003</PageID>
      <Name>Cat Supplies</Name>
      <PageFileName>cat-supplies.html</PageFileName>
    </Page>
  </Pages>
</ShopSitePages>
`;

// The fake CGI upload response embeds credential-shaped secrets. The route
// must persist only the redacted form; the test asserts the raw secrets never
// reach artifacts or job events.
const UPLOAD_OK_HTML = `<html><head><title>Upload complete</title></head><body>Upload OK. <a href="dbmake.cgi?return_string=fake-return-123&amp;session=fake-session&amp;merchant_id=FAKE_MERCHANT_SECRET&amp;password=FAKE_PASSWORD_SECRET">Build database</a></body></html>`;
const DBMAKE_OK_TEXT = `<html><head><title>Products Upload Results</title></head><body>Products Upload Results. Updated database record 1: Milestone One Product. Updated database record 14: done.</body></html>`;

interface FakeShopSite {
  liveProductsXml: string;
  pendingUploadXml: string;
  uploads: string[];
  generateMode: 'ok' | 'fail-500';
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
        return new Response(PAGES_XML, { status: 200, headers: { 'Content-Type': 'text/xml' } });
      }
      return new Response(fake.liveProductsXml, { status: 200, headers: { 'Content-Type': 'text/xml' } });
    }
    if (url.includes('dbupload.cgi')) {
      fake.uploads.push(bodyText);
      const marker = 'Content-Type: text/xml\r\n\r\n';
      const start = bodyText.indexOf(marker);
      const end = bodyText.lastIndexOf('\r\n--');
      fake.pendingUploadXml = start >= 0 && end > start ? bodyText.slice(start + marker.length, end) : '';
      return new Response(UPLOAD_OK_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    if (url.includes('dbmake.cgi')) {
      // The fake store applies the uploaded document at dbmake time.
      if (fake.pendingUploadXml) {
        fake.liveProductsXml = fake.pendingUploadXml;
        fake.pendingUploadXml = '';
      }
      return new Response(DBMAKE_OK_TEXT, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    if (url.includes('generate.cgi')) {
      if (fake.generateMode === 'fail-500') return new Response('generate failed', { status: 500 });
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

function codeBaseProduct(sku: string, index: number): Product {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: `prod-${sku}`,
    sku,
    status: 'active',
    core: {
      name: `Milestone One Product ${index + 1} ${sku}`,
      price: (10 + index).toFixed(2),
      salePrice: null,
      description: `Description for milestone one product ${sku}.`,
      taxable: true,
      availability: 'in stock',
      weight: null,
      inventory: { quantityOnHand: 10 + index, lowStockThreshold: null, outOfStockLimit: null },
      media: { primary: null, additional: [] },
      seo: { fileName: `m1-product-${index + 1}`, searchKeywords: null, googleProductCategory: null },
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
      source: { dbname: 'products', uniqueName: 'SKU' },
      preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
    },
    metadata: { createdAt: now, updatedAt: now, archivedAt: null },
  };
}

interface Fixture {
  workspacePath: string;
  workspaceId: string;
  changeSetId: string;
}

function setupMilestoneOne(): Fixture {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-m1-dryrun-'));
  const workspaceId = `ws-m1-dryrun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();

  insertWorkspace({
    id: workspaceId,
    name: 'm1-dryrun',
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

  // Approved baselines are the canonical decode of the fake live export, so
  // the live census equals the baseline record-for-record before any edit.
  const codeBases = SKUS.map((sku, i) => codeBaseProduct(sku, i));
  const liveXml = ShopSiteProductCodec.encodeMany(codeBases).xml;
  const decoded = ShopSiteProductCodec.decode(liveXml, { workspaceId });
  expect(decoded.products).toHaveLength(14);
  const baseBySku = new Map(decoded.products.map(p => [p.sku, p]));
  for (const p of decoded.products) writeProductFile(workspacePath, p);
  git.add(['products/', '.gitignore']);
  git.commit('Milestone-1 dry-run baseline');

  const db = getDb();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO classification_attribute_mappings
       (workspace_id, id, attribute_id, catalog_field, serialization_json, is_stale, config_hash, created_at, updated_at)
     VALUES (?, 'm1-flavor-map', 'flavor', 'ProductField23', ?, 0, '', ?, ?)`,
    [workspaceId, JSON.stringify({ format: 'direct', separator: ', ', prefix: '', suffix: '' }), now, now],
  );

  // Seed the verified page catalog before approval so the additive page join
  // resolves to a verified identity. The sync preflight later observes the
  // same source hash and reports up_to_date.
  const pageRecords = toPageRecords(parseShopSitePagesXml(PAGES_XML)).filter(
    r => r.identity.kind !== 'unverified_name_only',
  );
  expect(pageRecords).toHaveLength(3);
  activatePageImportFromRecords({
    workspaceId,
    sourceHash: sha256Hex(PAGES_XML),
    parserFormatVersion: 'shopsite-pages-xml-1',
    records: pageRecords,
    activatedBy: 'm1-dryrun-fixture',
  });
  expect(listVerifiedPageOptions(workspaceId).map(p => p.name).sort()).toEqual(
    ['Cat Supplies', 'Dog Supplies', 'Pet Food'],
  );

  // Catalog classification runs with accepted PF23 decisions (plus one
  // accepted additive page on the first SKU), bound via classification_run_id.
  // Each run binds a frozen V2 snapshot: accept decisions require captured
  // output authority (flavor→PF23 + canonical PF24/PF25 bindings).
  const M1_EVIDENCE: CatalogEvidence = {
    schemaVersion: 1,
    sourceTreeHash: '0'.repeat(64),
    productFileCount: 0,
    parseFailureCount: 0,
    parseFailures: [],
    fieldRegistry: { entryCount: 0, xmlFields: [] },
    fields: [],
    pages: [],
  };
  const m1Candidate = generateCandidate(BayStatePetGardenSeed, M1_EVIDENCE);
  const m1Bundle = m1Candidate.bundle;
  for (const binding of m1Bundle.classificationOutputBindings ?? []) {
    db.run(
      `INSERT OR REPLACE INTO classification_output_bindings
       (workspace_id, role, catalog_field, serialization_json, is_stale, config_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
      [workspaceId, binding.role, binding.catalogField, JSON.stringify(binding.serialization), 'm1', now, now],
    );
  }
  const runIds = new Map<string, string>();
  SKUS.forEach((sku, i) => {
    const snapshot = buildRuntimeSnapshot({
      workspaceId,
      workspacePath,
      productSku: sku,
      authority: { kind: 'v2' as const, bundle: m1Bundle },
      configSnapshotRef: {
        id: m1Bundle.manifest.bundleHash,
        hash: m1Bundle.manifest.bundleHash,
        sourceCommit: null,
        createdAt: now,
      },
      sourceProductHash: '',
    });
    const { hash } = persistRuntimeSnapshot(snapshot);
    const run = createRun(workspaceId, sku, null, hash, { sourceKind: 'catalog_product' });
    db.run(
      `INSERT INTO classification_proposals
         (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'field_assignment', 'flavor', ?, 0.9, 'pending', ?)`,
      [`m1-prop-${sku}`, run.id, sku, JSON.stringify(FLAVORS[i]), now],
    );
    const decisions: Array<{ proposalId: string; decision: 'accepted' }> = [
      { proposalId: `m1-prop-${sku}`, decision: 'accepted' },
    ];
    if (i === 0) {
      db.run(
        `INSERT INTO classification_proposals
           (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
         VALUES (?, ?, ?, 'category_page', NULL, ?, 0.8, 'pending', ?)`,
        [`m1-pageprop-${sku}`, run.id, sku, JSON.stringify('Pet Food'), now],
      );
      decisions.push({ proposalId: `m1-pageprop-${sku}`, decision: 'accepted' });
    }
    completeRun(run.id, 'completed');
    const reviewed = submitProposalDecisions({
      workspaceId,
      productSku: sku,
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions,
    });
    expect(reviewed.ok).toBe(true);
    runIds.set(sku, run.id);
  });

  const changeSet = createChangeSet({ workspaceId, title: 'Milestone-1 dry run', baseCommit: git.getHeadHash() });
  SKUS.forEach((sku, i) => {
    const base = baseBySku.get(sku)!;
    const draft = JSON.parse(JSON.stringify(base)) as Product;
    draft.customFields = { ...draft.customFields, ProductField23: FLAVORS[i] };
    if (i === 0) draft.core.productOnPages = ['Pet Food'];
    upsertChangeSetItem({
      changeSetId: changeSet.id,
      sku,
      operation: 'update',
      draftJson: deterministicStringify(draft),
      baseJson: deterministicStringify(base),
      draftHash: hashJson(draft),
      classificationRunId: runIds.get(sku)!,
    });
  });

  // Pre-stage an unrelated file: approval must leave it out of its commit.
  const unrelated = path.join(workspacePath, 'store', 'unrelated-config.json');
  fs.mkdirSync(path.dirname(unrelated), { recursive: true });
  fs.writeFileSync(unrelated, '{"staged":true}', 'utf-8');
  git.add(['store/unrelated-config.json']);

  const approved = approveChangeSet(changeSet.id, workspacePath);
  if (!approved.success) throw new Error(`Approval failed: ${approved.errors.join('; ')}`);
  expect(git.readFileAtHead('store/unrelated-config.json')).toBeNull();
  expect(git.status()).toContain('unrelated-config.json');

  // Verified page joins: the additive page resolves to a verified identity,
  // and untouched SKUs carry no page rows.
  const joins = getProductPageAssignments(SKUS[0]);
  expect(joins).toHaveLength(1);
  expect(joins[0].pageName).toBe('Pet Food');
  expect(joins[0].pageId).not.toBeNull();
  expect(getProductPages(SKUS[1])).toHaveLength(0);

  return { workspacePath, workspaceId, changeSetId: changeSet.id };
}

function readFilesSnapshot(workspacePath: string): string {
  const names = SKUS.map(skuToProductFilePath).sort();
  return JSON.stringify(names.map(n => [n, fs.readFileSync(path.join(workspacePath, n), 'utf-8')]));
}

describe('Milestone-1 backfill dry run (fake ShopSite only)', () => {
  it('pushes 14 unique top-level products update-only and reconciles 14/14 with redacted artifacts', async () => {
    const { workspacePath, changeSetId } = setupMilestoneOne();
    const approvedItemsBefore = JSON.stringify(listChangeSetItems(changeSetId));
    const filesBefore = readFilesSnapshot(workspacePath);

    const fake: FakeShopSite = {
      liveProductsXml: ShopSiteProductCodec.encodeMany(
        listChangeSetItems(changeSetId).map(i => JSON.parse(i.baseJson!) as Product),
      ).xml,
      pendingUploadXml: '',
      uploads: [],
      generateMode: 'ok',
    };
    installFakeShopSite(fake);

    const res = await makeApp().request('/api/sync/upload-only', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changeSetId, backfillMode: true }),
    });
    const responseText = await res.text();
    if (res.status !== 200) throw new Error(`upload-only failed (${res.status}): ${responseText}`);
    const body = JSON.parse(responseText) as {
      success: boolean; jobId: string; productCount: number; importReconciled: boolean;
      publishState: string; publishCompleted: boolean; publishVerified: boolean;
    };
    expect(body.success).toBe(true);
    expect(body.productCount).toBe(14);
    expect(body.importReconciled).toBe(true);
    // Upload-only never claims a storefront publish.
    expect(body.publishState).toBe('skipped');
    expect(body.publishCompleted).toBe(false);
    expect(body.publishVerified).toBe(false);

    // Gated backfill sync is update-only: every dbupload carried newRecords=no.
    expect(fake.uploads.length).toBeGreaterThan(0);
    for (const upload of fake.uploads) {
      expect(upload).toMatch(/name="newRecords"\r\n\r\nno\r\n/);
      expect(upload).not.toMatch(/name="newRecords"\r\n\r\nyes\r\n/);
      expect(upload).toContain('name="uniqueName"');
    }

    // 14 intended unique top-level products yield 14 reconciled unique live SKUs.
    const census = parseBackfillCensusXml(fake.liveProductsXml);
    expect(census.ok).toBe(true);
    expect(census.records).toHaveLength(14);
    expect(new Set(census.records.map(r => r.sku))).toEqual(new Set(SKUS));
    for (const sku of SKUS) expect(census.countsBySku[sku]).toBe(1);

    const lastUpload = fake.uploads[fake.uploads.length - 1];
    const marker = 'Content-Type: text/xml\r\n\r\n';
    const outgoingXml = lastUpload.slice(lastUpload.indexOf(marker) + marker.length, lastUpload.lastIndexOf('\r\n--'));
    const reconciliation = reconcileBackfillImport({
      attemptedSkus: SKUS,
      outgoingXml,
      freshLiveXml: fake.liveProductsXml,
    });
    expect(reconciliation.ok).toBe(true);
    expect(reconciliation.imported).toHaveLength(14);
    expect(reconciliation.skipped).toHaveLength(0);
    expect(reconciliation.duplicate).toHaveLength(0);
    expect(reconciliation.mismatched).toHaveLength(0);
    expect(reconciliation.unexpectedNew).toHaveLength(0);

    const job = findSyncJobById(body.jobId)!;
    expect(job.status).toBe('import_reconciled');

    // Redacted CGI artifacts contain real bodies but no credentials.
    const dbuploadArtifact = fs.readFileSync(
      path.join(workspacePath, 'exports', body.jobId, 'dbupload.cgi.redacted.txt'), 'utf-8');
    const dbmakeArtifact = fs.readFileSync(
      path.join(workspacePath, 'exports', body.jobId, 'dbmake.cgi.redacted.txt'), 'utf-8');
    expect(dbuploadArtifact).toContain('dbmake.cgi');
    expect(dbmakeArtifact).toContain('Products Upload Results');
    for (const text of [dbuploadArtifact, dbmakeArtifact]) {
      expect(text).not.toContain('FAKE_PASSWORD_SECRET');
      expect(text).not.toContain('FAKE_MERCHANT_SECRET');
    }
    const eventText = listSyncJobEvents(body.jobId).map(e => `${e.message}\n${e.detailsJson ?? ''}`).join('\n');
    expect(eventText).not.toContain('FAKE_PASSWORD_SECRET');
    expect(eventText).not.toContain('FAKE_MERCHANT_SECRET');

    // The approved XML is unchanged after the run.
    expect(JSON.stringify(listChangeSetItems(changeSetId))).toBe(approvedItemsBefore);
    expect(readFilesSnapshot(workspacePath)).toBe(filesBefore);
  });

  it('keeps a generate-500 import reconciled with pending publish and no published marker', async () => {
    const { workspacePath, changeSetId } = setupMilestoneOne();
    const approvedItemsBefore = JSON.stringify(listChangeSetItems(changeSetId));
    const filesBefore = readFilesSnapshot(workspacePath);

    const fake: FakeShopSite = {
      liveProductsXml: ShopSiteProductCodec.encodeMany(
        listChangeSetItems(changeSetId).map(i => JSON.parse(i.baseJson!) as Product),
      ).xml,
      pendingUploadXml: '',
      uploads: [],
      generateMode: 'fail-500',
    };
    installFakeShopSite(fake);

    const res = await makeApp().request('/api/sync/push-publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changeSetId, backfillMode: true }),
    });
    const responseText = await res.text();
    if (res.status !== 200) throw new Error(`push-publish failed (${res.status}): ${responseText}`);
    const body = JSON.parse(responseText) as {
      success: boolean; jobId: string; importReconciled: boolean;
      publishState: string; publishCompleted: boolean; publishVerified: boolean; warnings: string[];
    };
    expect(body.success).toBe(true);
    expect(body.importReconciled).toBe(true);
    expect(body.publishState).toBe('pending');
    expect(body.publishCompleted).toBe(false);
    expect(body.publishVerified).toBe(false);
    expect(body.warnings.length).toBeGreaterThan(0);

    const job = findSyncJobById(body.jobId)!;
    expect(job.status).toBe('import_reconciled');

    // No published marker anywhere: every SKU stays import_reconciled.
    for (const sku of SKUS) {
      expect(findProductBySku(sku)!.syncStatus).toBe('import_reconciled');
    }
    const eventText = listSyncJobEvents(body.jobId).map(e => e.message).join('\n');
    expect(eventText).toContain('pending');
    expect(eventText).not.toContain('published_verified');

    const generateArtifact = fs.readFileSync(
      path.join(workspacePath, 'exports', body.jobId, 'generate.cgi.redacted.txt'), 'utf-8');
    expect(generateArtifact).toContain('generate failed');

    // The approved XML is unchanged after the run.
    expect(JSON.stringify(listChangeSetItems(changeSetId))).toBe(approvedItemsBefore);
    expect(readFilesSnapshot(workspacePath)).toBe(filesBefore);
  });
});
