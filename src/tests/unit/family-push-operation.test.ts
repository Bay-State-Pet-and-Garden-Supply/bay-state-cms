/**
 * Family push operation seam (issue #373): deterministic plan, exact upload
 * wire shape, required-remote verification, and post-import reconciliation.
 *
 * Bun-side (bun:test + test:db, excluded from Vitest): the census-parser
 * chain reaches bun:sqlite transitively, like the other backfill seam
 * suites. Fixture products are hand-built; no live vendor credentials.
 */
import { describe, it, expect } from 'bun:test';
import {
  planFamilyPushSet,
  encodeFamilyPushXml,
  buildFamilyPushMultipart,
  expectedCensusRecordFor,
  checkRequiredRemoteMembers,
  assessFamilyPushReadiness,
  reconcileFamilyPushImport,
  liveCensusSkusOf,
  FAMILY_PUSH_MATCH_KEY,
  FAMILY_PUSH_NEW_RECORDS,
  FAMILY_PUSH_OPERATION_VERSION,
} from '../../shopsite/family-push-operation';
import { sha256Hex } from '../../shared/stable-id';
import type { LinkedManifest } from '../../shared/schemas/change-set';
import type { Product } from '../../shared/types';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';

function product(sku: string, overrides?: Partial<Product>): Product {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    schemaVersion: 1,
    id: `prod-${sku}`,
    sku,
    status: 'active',
    core: {
      name: `Product ${sku}`,
      price: '19.99',
      salePrice: null,
      description: `Description for ${sku}.`,
      taxable: true,
      availability: 'in stock',
      weight: null,
      inventory: { quantityOnHand: 10, lowStockThreshold: null, outOfStockLimit: null },
      media: { primary: null, additional: [] },
      seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
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
    ...overrides,
  } as Product;
}

function withSubproducts(p: Product, childSkus: string[]): Product {
  const inner = childSkus.map((sku) => `<Subproduct><SKU>${sku}</SKU><Name>${sku}</Name></Subproduct>`).join('');
  return {
    ...p,
    shopsite: {
      ...p.shopsite,
      preserved: {
        ...p.shopsite.preserved,
        advancedBlocks: { ...p.shopsite.preserved.advancedBlocks, Subproducts: `<Subproducts>${inner}</Subproducts>` },
      },
    },
  };
}

function manifestFor(products: Product[], ops: Record<string, string>): LinkedManifest {
  return {
    version: 1,
    changeSetId: 'cs-family-push-seam',
    workspaceId: 'ws-family-push-seam',
    baseCommit: 'base'.padEnd(40, '0'),
    writes: products.map((p) => ({
      sku: p.sku,
      operation: ops[p.sku] ?? 'update',
      filePath: `products/${p.sku}.json`,
      draftHash: 'd'.repeat(64),
      productHash: 'p'.repeat(64),
      nativeReferenceHash: 'n'.repeat(64),
      baseHash: null,
      baseApprovedCommit: null,
      pageNames: [],
    })),
    reads: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('family push operation seam (issue #373)', () => {
  it('plans one complete set: every write SKU ships, none split', () => {
    const parent = withSubproducts(product('PARENT-1'), ['CHILD-A', 'CHILD-B']);
    const a = product('CHILD-A');
    const b = product('CHILD-B');
    const manifest = manifestFor([parent, a, b], { 'PARENT-1': 'update', 'CHILD-A': 'update', 'CHILD-B': 'create' });
    const plan = planFamilyPushSet([parent, a, b], manifest);
    expect(plan.skus).toEqual(['CHILD-A', 'CHILD-B', 'PARENT-1']);
    expect(plan.requiredRemoteSkus).toEqual([]);
    expect(plan.newSkus).toEqual(['CHILD-B']);
    expect(plan.updateSkus).toEqual(['CHILD-A', 'PARENT-1']);
    expect(plan.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(FAMILY_PUSH_OPERATION_VERSION).toBe(1);
  });

  it('refuses a partial payload: approved write missing from the load', () => {
    const parent = withSubproducts(product('PARENT-1'), ['CHILD-A']);
    const manifest = manifestFor([parent, product('CHILD-A')], { 'PARENT-1': 'update', 'CHILD-A': 'update' });
    expect(() => planFamilyPushSet([parent], manifest)).toThrow(/family_push_incomplete_payload/);
  });

  it('derives unchanged referenced members as required remote checks', () => {
    const parent = withSubproducts(product('PARENT-1'), ['CHILD-A', 'CHILD-B']);
    const a = product('CHILD-A');
    // CHILD-B is referenced but not a write: it must be verified remotely.
    const manifest = manifestFor([parent, a], { 'PARENT-1': 'update', 'CHILD-A': 'update' });
    const plan = planFamilyPushSet([parent, a], manifest);
    expect(plan.skus).toEqual(['CHILD-A', 'PARENT-1']);
    expect(plan.requiredRemoteSkus).toEqual(['CHILD-B']);
  });

  it('encodes the exact outgoing XML in plan order with stable SKU matching + new-records yes', () => {
    const parent = withSubproducts(product('PARENT-1'), ['CHILD-A']);
    const a = product('CHILD-A');
    const manifest = manifestFor([parent, a], { 'PARENT-1': 'update', 'CHILD-A': 'create' });
    const plan = planFamilyPushSet([parent, a], manifest);
    const xml = encodeFamilyPushXml([parent, a], plan);
    expect(xml).toContain('<SKU>PARENT-1</SKU>');
    expect(xml).toContain('<SKU>CHILD-A</SKU>');
    expect(xml.indexOf('<SKU>CHILD-A</SKU>')).toBeLessThan(xml.indexOf('<SKU>PARENT-1</SKU>'));
    const multipart = buildFamilyPushMultipart(xml);
    const text = new TextDecoder().decode(multipart.body);
    expect(text).toContain(`name="uniqueName"\r\n\r\n${FAMILY_PUSH_MATCH_KEY}\r\n`);
    expect(text).toContain(`name="newRecords"\r\n\r\n${FAMILY_PUSH_NEW_RECORDS}\r\n`);
    expect(multipart.contentType).toContain('multipart/form-data; boundary=');
    expect(multipart.contentLength).toBe(multipart.body.length);
  });
  it('payload identity is the reconciled upload bytes: hash(xml) is the recorded identity, upload, and reconcile baseline', () => {
    const parent = withSubproducts(product('PARENT-1'), ['CHILD-A']);
    const a = product('CHILD-A');
    const manifest = manifestFor([parent, a], { 'PARENT-1': 'update', 'CHILD-A': 'create' });
    const plan = planFamilyPushSet([parent, a], manifest);
    // The route records sha256Hex of the page-reconciled encode output —
    // the same document it uploads and the verdict replays — so the three
    // are one identical byte string by construction.
    const reconciledXml = encodeFamilyPushXml([parent, a], plan);
    const reconciledHash = sha256Hex(reconciledXml);
    expect(reconciledHash).toMatch(/^[0-9a-f]{64}$/);
    const verdict = reconcileFamilyPushImport({
      attemptedSkus: plan.skus,
      outgoingXml: reconciledXml,
      freshLiveXml: reconciledXml,
      baselineSkus: [],
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.imported).toEqual(plan.skus);
  });
  it('verifies required remote members: present+current passes, missing/duplicate/diverged block', () => {
    const liveMember = product('CHILD-B');
    const expected = expectedCensusRecordFor(liveMember)!;
    const liveXml = ShopSiteProductCodec.encodeMany([liveMember]).xml;

    const ok = checkRequiredRemoteMembers(['CHILD-B'], liveXml, { 'CHILD-B': expected });
    expect(ok).toHaveLength(1);
    expect(ok[0]?.ok).toBe(true);

    const missing = checkRequiredRemoteMembers(
      ['CHILD-B'],
      ShopSiteProductCodec.encodeMany([product('OTHER')]).xml,
      { 'CHILD-B': expected },
    );
    expect(missing[0]?.ok).toBe(false);
    expect(missing[0]?.reason).toContain('absent');

    const dupe = checkRequiredRemoteMembers(
      ['CHILD-B'],
      ShopSiteProductCodec.encodeMany([liveMember, liveMember]).xml,
      { 'CHILD-B': expected },
    );
    expect(dupe[0]?.ok).toBe(false);
    expect(dupe[0]?.reason).toContain('appears 2 times');

    const drifted = { ...liveMember, core: { ...liveMember.core, price: '99.99' } };
    const driftedXml = ShopSiteProductCodec.encodeMany([drifted]).xml;
    const stale = checkRequiredRemoteMembers(['CHILD-B'], driftedXml, { 'CHILD-B': expected });
    expect(stale[0]?.ok).toBe(false);
    expect(stale[0]?.reason).toContain('differs live');
  });

  it('readiness blocks without a live census when remote members are required', () => {
    const parent = withSubproducts(product('PARENT-1'), ['CHILD-B']);
    const manifest = manifestFor([parent], { 'PARENT-1': 'update' });
    const readiness = assessFamilyPushReadiness([parent], manifest, null);
    expect(readiness.ok).toBe(false);
    expect(readiness.remoteChecks).toEqual([]);
    expect([...readiness.wireOrder]).toEqual(['dbupload.cgi', 'dbmake.cgi', 'db_xml.cgi (reconcile census)', 'generate.cgi']);
  });

  it('reconciles a complete import; partial/unknown outcomes never report ok', () => {
    const a = product('CHILD-A');
    const b = product('CHILD-B');
    const outgoing = ShopSiteProductCodec.encodeMany([a, b]).xml;
    const complete = reconcileFamilyPushImport({ attemptedSkus: ['CHILD-A', 'CHILD-B'], outgoingXml: outgoing, freshLiveXml: outgoing });
    expect(complete.ok).toBe(true);
    expect(complete.imported).toEqual(['CHILD-A', 'CHILD-B']);
    expect(complete.unexpectedNew).toEqual([]);

    const partialLive = ShopSiteProductCodec.encodeMany([a]).xml;
    const partial = reconcileFamilyPushImport({ attemptedSkus: ['CHILD-A', 'CHILD-B'], outgoingXml: outgoing, freshLiveXml: partialLive });
    expect(partial.ok).toBe(false);
    expect(partial.skipped).toEqual(['CHILD-B']);

    const unknown = reconcileFamilyPushImport({ attemptedSkus: ['CHILD-A'], outgoingXml: outgoing, freshLiveXml: '<broken' });
    expect(unknown.ok).toBe(false);

    const extra = product('EXTRA');
    const extraLive = ShopSiteProductCodec.encodeMany([a, b, extra]).xml;
    const surprise = reconcileFamilyPushImport({ attemptedSkus: ['CHILD-A', 'CHILD-B'], outgoingXml: outgoing, freshLiveXml: extraLive });
    expect(surprise.ok).toBe(false);
    expect(surprise.unexpectedNew).toEqual(['EXTRA']);
  });

  it('scopes unexpectedNew against the pre-upload baseline: pre-existing store SKUs pass, concurrent SKUs fail closed', () => {
    const a = product('CHILD-A');
    const b = product('CHILD-B');
    const outgoing = ShopSiteProductCodec.encodeMany([a, b]).xml;
    const preexisting = product('STORE-OLD');
    const preLive = ShopSiteProductCodec.encodeMany([preexisting]).xml;
    const baseline = liveCensusSkusOf(preLive);
    expect(baseline).toEqual(['STORE-OLD']);

    // Populated store: pre-existing SKU outside the set reconciles fine.
    const populatedLive = ShopSiteProductCodec.encodeMany([a, b, preexisting]).xml;
    const populated = reconcileFamilyPushImport({ attemptedSkus: ['CHILD-A', 'CHILD-B'], outgoingXml: outgoing, freshLiveXml: populatedLive, baselineSkus: baseline });
    expect(populated.ok).toBe(true);
    expect(populated.unexpectedNew).toEqual([]);

    // A SKU created concurrently (in neither the attempt nor the baseline)
    // still fails closed.
    const concurrent = product('CONCURRENT-1');
    const concurrentLive = ShopSiteProductCodec.encodeMany([a, b, preexisting, concurrent]).xml;
    const raced = reconcileFamilyPushImport({ attemptedSkus: ['CHILD-A', 'CHILD-B'], outgoingXml: outgoing, freshLiveXml: concurrentLive, baselineSkus: baseline });
    expect(raced.ok).toBe(false);
    expect(raced.unexpectedNew).toEqual(['CONCURRENT-1']);

    // Omitted baseline keeps the legacy strict verdict.
    const strict = reconcileFamilyPushImport({ attemptedSkus: ['CHILD-A', 'CHILD-B'], outgoingXml: outgoing, freshLiveXml: populatedLive });
    expect(strict.ok).toBe(false);
    expect(strict.unexpectedNew).toEqual(['STORE-OLD']);

    expect(liveCensusSkusOf('<broken')).toBeNull();
  });
});
