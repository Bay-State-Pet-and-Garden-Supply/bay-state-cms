/**
 * Real selection → verifier → confirmation workflow (issue #364 smoke).
 *
 * Runs under `bun test` (excluded from vitest) — writes discovery runs,
 * sources, model-call audit rows, and official-page decisions via
 * `bun:sqlite`. No network beyond stubbed `fetch`: the SystemOne Choice,
 * the page fetch, and the extractor-profile lookup are all stubbed in-test.
 *
 * Proves the complete gated behavior end to end with supported examples:
 * 1. Closed-set selection over supplied candidates returns the exact URL
 *    by ID (no invented URLs).
 * 2. The selected URL passes the existing page-verifier + identity +
 *    confirmation flow and records a durable official-page decision.
 * 3. A selected URL that fails verification never auto-selects and never
 *    confirms — safe candidates remain for manual resolution.
 * 4. Stale confirmations (moved item revision, superseded run) fail closed.
 * 5. Distributor-record items stay URL-null, skip Discovery, and retain
 *    zero-fetch deterministic materialization.
 *
 * This suite declares NO production qualification and makes NO paid or
 * live-store requests.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
// File-scoped job-queue mock: other suites (e.g. brand-strategy-select-source-guard)
// mock createDiscoveryFetch process-wide via mock.module. This file's confirmation
// flow re-fetches through the real SSRF-guarded path, so override it here to
// delegate to the per-test globalThis.fetch stub instead of a canned page.
mock.module('../../onboarding/job-queue', () => ({
  createDiscoveryFetch:
    () =>
    (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      (globalThis.fetch as unknown as (input: string | URL | Request, init?: RequestInit) => Promise<Response>)(input, init),
}));
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { upsertBrandSite } from '../../db/repositories/brand-site-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, findItemById } from '../../db/repositories/onboarding-item-repo';
import {
  insertSources,
  listSourcesByItem,
  createDiscoveryRun,
} from '../../db/repositories/onboarding-source-repo';
import { getDiscoveryModelCallsByRun } from '../../db/repositories/discovery-model-call-repo';
import {
  selectOfficialPageWithTypesafe,
  type SitemapSelectionCandidate,
} from '../../onboarding/sitemap-selection';
import { verifyCandidate, type VerificationContext } from '../../onboarding/page-verifier';
import {
  confirmOfficialPageCandidate,
  OfficialPageConfirmationError,
} from '../../onboarding/official-page-confirmation';
import { listOfficialPageDecisions } from '../../db/repositories/official-page-decision-repo';
import { buildModelPolicyView, type ModelPolicyView } from '../../classification/model-policy-gateway';
import { TYPESAFE_EVALUATED_MODEL } from '../../ai/systemone-transport';
import { upsertProviderConnection } from '../../db/repositories/provider-connection-repo';
import type { ProviderConnection } from '../../ai/provider-connections';
import type { Workspace } from '../../shared/types';
import type { lookup as NodeDnsLookup } from 'node:dns/promises';

type DnsLookupFn = typeof NodeDnsLookup;
type DnsLookupOptions = { all?: boolean };
// Offline-safe DNS for the SSRF-guarded discovery fetch. The confirmation
// flow re-fetches through `assertSafeVariantDestination`, which resolves
// hostnames via node:dns/promises. In sandboxes without DNS the acme.example
// fixtures fail closed before the stubbed fetch is reached. Resolve the
// fixture domain to its public documentation IP (93.184.216.34 — non-private,
// so the SSRF floor is still exercised) and delegate every other hostname to
// the real resolver. Scoped to this file: bun isolates module registries per
// test file.
mock.module('node:dns/promises', () => ({
  lookup: (async (hostname: string, options?: DnsLookupOptions) => {
    if (hostname === 'acme.example' || hostname.endsWith('.acme.example')) {
      const recs = [{ address: '93.184.216.34', family: 4 }];
      return options?.all ? recs : recs[0];
    }
    const recs = await Bun.dns.lookup(hostname);
    const mapped = recs.map((r) => ({ address: r.address, family: r.family }));
    return options?.all ? mapped : mapped[0];
  }) as DnsLookupFn,
}));

const PRODUCT_HTML = (title: string, gtin: string): string => `
<html><head><title>${title}</title>
<script type="application/ld+json">
{"@context":"https://schema.org/","@type":"Product","name":"${title}","gtin12":"${gtin}"}
</script></head>
<body><h1>${title}</h1><p>Official brand product page.</p></body></html>`;

function policyView(): ModelPolicyView {
  return buildModelPolicyView(
    {
      defaultProvider: 'typesafe',
      defaultModel: TYPESAFE_EVALUATED_MODEL,
      providerLocalities: { typesafe: 'cloud' },
      stageOverrides: {},
      imageDataSharing: 'local_only',
      textDataSharing: 'cloud_allowed',
      mlFeatures: {
        productionRetrieval: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        pageReranking: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        confidenceCalibration: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        productionEmbeddings: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
      },
    } as never,
    { snapshotHash: 'snap-workflow-364' },
  );
}

function stubFetch(handler: (url: unknown, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => handler(url, init)) as unknown as typeof fetch;
}

function systemOneBody(choice: string, probs: Record<string, number>): Record<string, unknown> {
  return {
    model: TYPESAFE_EVALUATED_MODEL,
    answers: {
      sitemap_selection: { type: 'choice', choice, probabilities: probs, confidence: 0.8 },
    },
    usage: { input_tokens: 120, output_tokens: 8 },
  };
}

describe('sitemap selection → verifier → confirmation workflow (issue #364)', () => {
  let tempDir: string;
  let workspaceId: string;
  let wsPath: string;
  let batchId: string;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sitemap-workflow-364-'));
    initDb(path.join(tempDir, 'test.db'));
    runMigrations();
    getDb().run('DELETE FROM ai_workload_routes');
    getDb().run('DELETE FROM provider_connections');
    getDb().run('DELETE FROM ai_routing_defaults');
        const conn: ProviderConnection = {
      id: 'typesafe-jev',
      label: 'TypeSafe Jev (Cloud)',
      transport: 'systemone',
      baseUrl: 'https://api.typesafe.ai/v1',
      credential: 'fixturekey',
      trustZone: 'cloud',
      approvedHost: 'api.typesafe.ai',
      approvedPort: 443,
      enabled: true,
      connectTimeoutMs: 2000,
      inferenceTimeoutMs: 5000,
    };
    upsertProviderConnection(conn);
    wsPath = path.join(tempDir, 'ws');
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    fs.mkdirSync(path.join(wsPath, 'store', 'classification'), { recursive: true });
    workspaceId = 'ws-workflow-364';
    const ws: Workspace = {
      id: workspaceId,
      name: 'Workflow 364',
      workspacePath: wsPath,
      gitPath: path.join(wsPath, '.git'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    };
    insertWorkspace(ws);
    upsertBrandSite('Acme', 'acme.example');
    batchId = createBatch({ workspaceId, name: 'batch-364', fileName: 'batch-364.csv', totalItems: 4 }).id;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    closeDb();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('selected URL verifies with structured proof and confirms a durable decision', async () => {
    const [item] = insertItems(batchId, [{
      name: 'ACME Widget 12 OZ',
      upc: '017800010009',
      brandHint: 'Acme',
      rowNumber: 1,
      stage: 'discovery',
    }]);
    const fresh = findItemById(item.id);
    if (!fresh) throw new Error('item missing');

    const supplied: SitemapSelectionCandidate[] = [
      { id: 'cand_0', url: 'https://acme.example/products/widget-12oz', retrievalRank: 0.9, title: 'ACME Widget 12 OZ' },
      { id: 'cand_1', url: 'https://acme.example/products/widget-16oz', retrievalRank: 0.5, title: 'ACME Widget 16 OZ' },
    ];

    stubFetch((url, init) => {
      const body = JSON.parse((init?.body as string) ?? '{}') as {
        questions?: Record<string, { criteria?: Record<string, string> }>;
      };
      // Closed set: criteria carry candidate IDs only.
      const criteria = body.questions?.sitemap_selection?.criteria ?? {};
      expect(Object.keys(criteria).sort()).toEqual(['cand_0', 'cand_1', 'insufficient_evidence', 'no_match'].sort());
      // The HTML page fetch never reaches this stub in this test (the
      // verifier gets its own stub below); SystemOne calls carry a body.
      return new Response(JSON.stringify(systemOneBody('cand_0', {
        cand_0: 0.84, cand_1: 0.08, no_match: 0.05, insufficient_evidence: 0.03,
      })), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const runId = createDiscoveryRun(item.id, {
      trigger: 'automatic',
      upc: '017800010009',
      name: 'ACME Widget 12 OZ',
    });
    const selection = await selectOfficialPageWithTypesafe({
      candidates: supplied,
      meta: {
        registerName: 'ACME Widget 12 OZ',
        consolidatedName: 'ACME Widget 12 OZ',
        upc: '017800010009',
        sku: null,
        brandHint: 'Acme',
        variantTokens: ['12', 'oz'],
        approvedDomains: ['acme.example'],
      },
      modelPolicy: policyView(),
      runId,
      itemId: item.id,
    });

    expect(selection.outcome).toBe('selected');
    expect(selection.selectedUrl).toBe('https://acme.example/products/widget-12oz');
    // Durable audit: one completed success row bound to the discovery run.
    expect(getDiscoveryModelCallsByRun(runId).map(r => r.status)).toEqual(['success']);

    // Verify the SELECTED url with the real verifier against stubbed HTML
    // carrying structured GTIN proof for the registered UPC.
    const context: VerificationContext = {
      upc: '017800010009',
      expectedName: 'ACME Widget 12 OZ',
      brandHint: 'Acme',
      officialDomains: ['acme.example'],
    };
    const pageFetch = (async () =>
      new Response(PRODUCT_HTML('ACME Widget 12 OZ', '017800010009'), {
        status: 200, headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;
    const verified = await verifyCandidate(
      {
        url: selection.selectedUrl ?? '',
        title: null,
        confidence: 0.9,
        sourceMethod: 'sitemap_name',
      },
      context,
      pageFetch,
    );
    expect(verified).not.toBeNull();
    expect(verified?.proofClass).toBe('exact_structured_gtin');
    expect(verified?.hasStrongProof).toBe(true);

    // Confirm through the real confirmation flow (attested; stub page fetch).
    stubFetch(() =>
      new Response(PRODUCT_HTML('ACME Widget 12 OZ', '017800010009'), {
        status: 200, headers: { 'content-type': 'text/html' },
      }),
    );
    const [source] = insertSources(item.id, [{
      url: selection.selectedUrl ?? '',
      title: null,
      confidence: 0.9,
      domain: 'acme.example',
      sourceMethod: 'sitemap_name',
      discoveryRunId: 'dr_workflow_live',
    }]);
    const decision = await confirmOfficialPageCandidate({
      item: { ...fresh, stage: 'find_product_page' as never },
      source,
      workspaceId,
      attestedProductAndVariant: true,
      expectedUpdatedAt: fresh.updatedAt,
      expectedDiscoveryRunId: 'dr_workflow_live',
    });

    expect(decision.url).toBe('https://acme.example/products/widget-12oz');
    expect(listOfficialPageDecisions(item.id)).toHaveLength(1);
    expect(listOfficialPageDecisions(item.id)[0]?.sourceRunId).toBe('dr_workflow_live');
    // Discovery runs are worker-owned; confirmation binds the decision to the
    // candidate source row (selection itself needs no run).
    expect(listSourcesByItem(item.id).some(s => s.isSelected)).toBe(true);
  });
  test('selected URL that fails verification never confirms; manual outcome preserved', async () => {
    const [item] = insertItems(batchId, [{
      name: 'ACME Widget 12 OZ',
      upc: '017800010009',
      brandHint: 'Acme',
      rowNumber: 1,
      stage: 'discovery',
    }]);
    const supplied: SitemapSelectionCandidate[] = [
      { id: 'cand_0', url: 'https://acme.example/products/widget-12oz', retrievalRank: 0.9 },
      { id: 'cand_1', url: 'https://acme.example/collections/all', retrievalRank: 0.4 },
    ];

    stubFetch(() =>
      new Response(JSON.stringify(systemOneBody('cand_1', {
        cand_1: 0.7, cand_0: 0.15, no_match: 0.1, insufficient_evidence: 0.05,
      })), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const runId = createDiscoveryRun(item.id, {
      trigger: 'automatic',
      upc: '017800010009',
      name: 'ACME Widget 12 OZ',
    });
    const selection = await selectOfficialPageWithTypesafe({
      candidates: supplied,
      meta: {
        registerName: 'ACME Widget 12 OZ',
        upc: '017800010009',
        sku: null,
        brandHint: 'Acme',
        variantTokens: [],
        approvedDomains: ['acme.example'],
      },
      modelPolicy: policyView(),
      runId,
      itemId: item.id,
    });
    expect(selection.outcome).toBe('selected');
    expect(getDiscoveryModelCallsByRun(runId).map(r => r.status)).toEqual(['success']);

    // The selected collection page has no structured proof — verification
    // fails closed and confirmation refuses the wrong page.
    const verified = await verifyCandidate(
      { url: selection.selectedUrl ?? '', confidence: 0.7, sourceMethod: 'sitemap_name' },
      {
        upc: '017800010009',
        expectedName: 'ACME Widget 12 OZ',
        brandHint: 'Acme',
        officialDomains: ['acme.example'],
      },
      (async () =>
        new Response('<html><head><title>All products</title></head><body><h1>Collection</h1></body></html>', {
          status: 200, headers: { 'content-type': 'text/html' },
        })) as unknown as typeof fetch,
    );
    expect(verified?.hasStrongProof).toBe(false);

    const fresh = findItemById(item.id);
    if (!fresh) throw new Error('item missing');
    stubFetch(() =>
      new Response('<html><head><title>All products</title></head><body><h1>Collection</h1></body></html>', {
        status: 200, headers: { 'content-type': 'text/html' },
      }),
    );
    const [source] = insertSources(item.id, [{
      url: selection.selectedUrl ?? '',
      confidence: 0.7,
      domain: 'acme.example',
      sourceMethod: 'sitemap_name',
      discoveryRunId: runId,
    }]);
    await expect(confirmOfficialPageCandidate({
      item: { ...fresh, stage: 'find_product_page' as never },
      source,
      workspaceId,
      attestedProductAndVariant: true,
      expectedUpdatedAt: fresh.updatedAt,
      expectedDiscoveryRunId: runId,
    })).rejects.toThrow(OfficialPageConfirmationError);
    // Safe candidates remain for the operator's manual outcome.
    expect(listOfficialPageDecisions(item.id)).toHaveLength(0);
    expect(listSourcesByItem(item.id).length).toBeGreaterThan(0);
  });

  test('stale confirmation never overwrites a newer decision', async () => {
    const [item] = insertItems(batchId, [{
      name: 'ACME Widget 12 OZ',
      upc: '017800010009',
      brandHint: 'Acme',
      rowNumber: 1,
      stage: 'discovery',
    }]);
    const fresh = findItemById(item.id);
    if (!fresh) throw new Error('item missing');
    const [source] = insertSources(item.id, [{
      url: 'https://acme.example/products/widget-12oz',
      confidence: 0.9,
      domain: 'acme.example',
      sourceMethod: 'sitemap_name',
      discoveryRunId: 'dr_live_stale',
    }]);
    stubFetch(() =>
      new Response(PRODUCT_HTML('ACME Widget 12 OZ', '017800010009'), {
        status: 200, headers: { 'content-type': 'text/html' },
      }),
    );

    // Wrong revision: the item moved while confirmation was in flight.
    await expect(confirmOfficialPageCandidate({
      item: { ...fresh, stage: 'find_product_page' as never },
      source,
      workspaceId,
      attestedProductAndVariant: true,
      expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
      expectedDiscoveryRunId: 'dr_live_stale',
    })).rejects.toMatchObject({ code: 'stale_item' });

    // Unknown run binding: the candidate came from a superseded run.
    await expect(confirmOfficialPageCandidate({
      item: { ...fresh, stage: 'find_product_page' as never },
      source,
      workspaceId,
      attestedProductAndVariant: true,
      expectedUpdatedAt: fresh.updatedAt,
      expectedDiscoveryRunId: 'dr_superseded',
    })).rejects.toMatchObject({ code: 'stale_item' });

    // Legacy NULL-run rows are explicitly unconfirmable with a re-run reason.
    const [legacy] = insertSources(item.id, [{
      url: 'https://acme.example/products/widget-legacy',
      confidence: 0.9,
      domain: 'acme.example',
      sourceMethod: 'sitemap_name',
    }]);
    await expect(confirmOfficialPageCandidate({
      item: { ...fresh, stage: 'find_product_page' as never },
      source: legacy,
      workspaceId,
      attestedProductAndVariant: true,
      expectedUpdatedAt: fresh.updatedAt,
      expectedDiscoveryRunId: 'dr_live_stale',
    })).rejects.toMatchObject({ code: 'source_not_selectable' });
  });

  test('insertSources stamps the owning run; matching binding confirms', async () => {
    const [item] = insertItems(batchId, [{
      name: 'ACME Widget 12 OZ',
      upc: '017800010009',
      brandHint: 'Acme',
      rowNumber: 5,
      stage: 'discovery',
    }]);
    const fresh = findItemById(item.id);
    if (!fresh) throw new Error('item missing');
    const [source] = insertSources(item.id, [{
      url: 'https://acme.example/products/widget-12oz',
      confidence: 0.9,
      domain: 'acme.example',
      sourceMethod: 'sitemap_name',
      discoveryRunId: 'dr_live_1',
    }]);
    expect(source.discoveryRunId).toBe('dr_live_1');
    expect(listSourcesByItem(item.id)[0]?.discoveryRunId).toBe('dr_live_1');
    stubFetch(() =>
      new Response(PRODUCT_HTML('ACME Widget 12 OZ', '017800010009'), {
        status: 200, headers: { 'content-type': 'text/html' },
      }),
    );
    const decision = await confirmOfficialPageCandidate({
      item: { ...fresh, stage: 'find_product_page' as never },
      source,
      workspaceId,
      attestedProductAndVariant: true,
      expectedUpdatedAt: fresh.updatedAt,
      expectedDiscoveryRunId: 'dr_live_1',
    });
    expect(decision.sourceRunId).toBe('dr_live_1');
  });

  test('run-bound selection audit rows carry the owning run and frozen hash', async () => {
    const [item] = insertItems(batchId, [{
      name: 'ACME Widget 12 OZ',
      upc: '017800010009',
      brandHint: 'Acme',
      rowNumber: 6,
      stage: 'discovery',
    }]);
    stubFetch(() =>
      new Response(JSON.stringify(systemOneBody('cand_0', {
        cand_0: 0.9, cand_1: 0.05, no_match: 0.03, insufficient_evidence: 0.02,
      })), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const runId = createDiscoveryRun(item.id, {
      trigger: 'automatic',
      upc: '017800010009',
      name: 'ACME Widget 12 OZ',
    });
    const selection = await selectOfficialPageWithTypesafe({
      candidates: [
        { id: 'cand_0', url: 'https://acme.example/products/widget-12oz', retrievalRank: 0.9 },
        { id: 'cand_1', url: 'https://acme.example/products/widget-16oz', retrievalRank: 0.5 },
      ],
      meta: {
        registerName: 'ACME Widget 12 OZ',
        upc: '017800010009',
        sku: 'ACME-12',
        brandHint: 'Acme',
        variantTokens: [],
        approvedDomains: ['acme.example'],
      },
      modelPolicy: policyView(),
      runId,
      itemId: item.id,
      snapshotHash: 'snap-frozen-2',
    });
    expect(selection.outcome).toBe('selected');
    expect(selection.modelCallIds.length).toBeGreaterThan(0);
    expect(selection.selectionAudit.length).toBeGreaterThan(0);
    const audit = selection.selectionAudit.find(r => r.status !== 'started') ?? selection.selectionAudit[0];
    expect(audit.runId).toBe(runId);
    expect(audit.snapshotHash).toBe('snap-frozen-2');
    expect(selection.selectionAudit.every(r => r.runId === runId && r.snapshotHash === 'snap-frozen-2')).toBe(true);
    // Durable audit: DB rows carry the same run binding and frozen hash.
    const rows = getDiscoveryModelCallsByRun(runId);
    expect(rows.length).toBe(1);
    expect(rows.every(r => r.run_id === runId && r.snapshot_hash === 'snap-frozen-2')).toBe(true);
    expect(rows.map(r => r.status)).toEqual(['success']);
  });

  test('distributor-record items stay URL-null with zero-fetch materialization', async () => {
    const [item] = insertItems(batchId, [{
      name: 'ACME Distributor Widget',
      upc: '017800010009',
      brandHint: 'Acme',
      rowNumber: 4,
      stage: 'discovery',
    }]);
    getDb().run(`UPDATE onboarding_items SET source_type = 'distributor_record' WHERE id = ?`, [item.id]);
    const fresh = findItemById(item.id);
    if (!fresh) throw new Error('item missing');
    expect(fresh.sourceType).toBe('distributor_record');
    expect(fresh.sourceUrl).toBeNull();

    // Confirmation refuses distributor records: they never enter Discovery
    // and never confirm an official page.
    const [source] = insertSources(item.id, [{
      url: 'https://acme.example/products/widget-12oz',
      confidence: 0.9,
      domain: 'acme.example',
      sourceMethod: 'sitemap_name',
      discoveryRunId: 'dr_distributor_probe',
    }]);
    await expect(confirmOfficialPageCandidate({
      item: { ...fresh, stage: 'route_sources' as never },
      source,
      workspaceId,
      attestedProductAndVariant: true,
      expectedUpdatedAt: fresh.updatedAt,
      expectedDiscoveryRunId: 'dr_distributor_probe',
    })).rejects.toMatchObject({ code: 'source_not_selectable' });
  });
  test('no-GTIN exact name and variant confirms automatically without model work', async () => {
    const [item] = insertItems(batchId, [{
      name: 'ACME Turbo Widget 12 OZ', upc: '017800010009', brandHint: 'Acme', rowNumber: 7, stage: 'discovery',
    }]);
    const fresh = findItemById(item.id);
    if (!fresh) throw new Error('item missing');
    const runId = createDiscoveryRun(item.id, { trigger: 'automatic', upc: item.upc, name: item.name });
    const [source] = insertSources(item.id, [{
      url: 'https://acme.example/products/widget-12oz', confidence: 0.9, domain: 'acme.example',
      sourceMethod: 'sitemap_name', discoveryRunId: runId,
    }]);
    stubFetch(() => new Response('<html><head><title>Document title differs</title></head><body><h1>ACME Turbo Widget 12 OZ</h1></body></html>', { status: 200 }));
    const decision = await confirmOfficialPageCandidate({
      item: { ...fresh, stage: 'find_product_page' as never }, source, workspaceId,
      attestedProductAndVariant: false, expectedUpdatedAt: fresh.updatedAt, expectedDiscoveryRunId: runId,
    });
    expect(decision.evidenceKind).toBe('automatic_name');
    expect(decision.sourceRunId).toBe(runId);
    expect(listSourcesByItem(item.id).find(row => row.id === source.id)?.isSelected).toBe(true);
    expect(getDiscoveryModelCallsByRun(runId)).toHaveLength(0);
  });

  test('refuses contradictory GTIN, wrong variant, variant conflict, listing, and off-domain sources', async () => {
    const cases = [
      { name: 'contradictory GTIN', heading: 'ACME Turbo Widget 12 OZ', body: '<script type="application/ld+json">{"@type":"Product","name":"ACME Turbo Widget 12 OZ","gtin12":"017800010016"}</script>', url: 'https://acme.example/products/widget-12oz', code: 'identity_conflict' },
      { name: 'wrong variant', heading: 'ACME Turbo Widget 24 OZ', body: '', url: 'https://acme.example/products/widget-24oz', code: 'identity_conflict' },
      { name: 'heading/variant conflict', heading: 'ACME Turbo Widget 12 OZ', body: '<script>window.productJSON = {\"variants\":[{\"id\":1,\"title\":\"24 OZ\"}]};</script>', url: 'https://acme.example/products/widget-12oz', code: 'identity_conflict' },
      { name: 'listing page', heading: 'All products', body: '', url: 'https://acme.example/collections/all', code: 'wrong_page' },
      { name: 'retailer page', heading: 'ACME Turbo Widget 12 OZ', body: '', url: 'https://retailer.example/products/widget-12oz', code: 'strategy_source_not_approved' },
    ] as const;
    for (const [index, scenario] of cases.entries()) {
      const [item] = insertItems(batchId, [{
        name: 'ACME Turbo Widget 12 OZ', upc: '017800010009', brandHint: 'Acme', rowNumber: 10 + index, stage: 'discovery',
      }]);
      const fresh = findItemById(item.id);
      if (!fresh) throw new Error('item missing');
      const runId = `dr_refuse_${index}`;
      const [source] = insertSources(item.id, [{
        url: scenario.url, confidence: 0.9,
        domain: new URL(scenario.url).hostname, sourceMethod: 'sitemap_name', discoveryRunId: runId,
      }]);
      stubFetch(() => new Response(`<html><head><title>${scenario.heading}</title>${scenario.body}</head><body><h1>${scenario.heading}</h1></body></html>`, { status: 200 }));
      await expect(confirmOfficialPageCandidate({
        item: { ...fresh, stage: 'find_product_page' as never }, source, workspaceId,
        attestedProductAndVariant: false, expectedUpdatedAt: fresh.updatedAt, expectedDiscoveryRunId: runId,
      })).rejects.toMatchObject({ code: scenario.code });
      expect(listOfficialPageDecisions(item.id)).toHaveLength(0);
    }
  });

  test('stale run binding leaves newer item state untouched', async () => {
    const [item] = insertItems(batchId, [{
      name: 'ACME Turbo Widget 12 OZ', upc: '017800010009', brandHint: 'Acme', rowNumber: 20, stage: 'discovery',
    }]);
    const fresh = findItemById(item.id);
    if (!fresh) throw new Error('item missing');
    const [source] = insertSources(item.id, [{
      url: 'https://acme.example/products/widget-12oz', confidence: 0.9, domain: 'acme.example',
      sourceMethod: 'sitemap_name', discoveryRunId: 'dr_stale_actual',
    }]);
    stubFetch(() => new Response('<html><body><h1>ACME Turbo Widget 12 OZ</h1></body></html>', { status: 200 }));
    await expect(confirmOfficialPageCandidate({
      item: { ...fresh, stage: 'find_product_page' as never }, source, workspaceId,
      attestedProductAndVariant: false, expectedUpdatedAt: fresh.updatedAt, expectedDiscoveryRunId: 'dr_stale_expected',
    })).rejects.toMatchObject({ code: 'stale_item' });
    expect(findItemById(item.id)?.sourceUrl).toBeNull();
    expect(listOfficialPageDecisions(item.id)).toHaveLength(0);
    expect(listSourcesByItem(item.id).find(row => row.id === source.id)?.isSelected).toBe(false);
  });

  test('manual attestation still confirms a needs-operator name match', async () => {
    const [item] = insertItems(batchId, [{
      name: 'ACME Turbo Widget 12 OZ', upc: '017800010009', brandHint: 'Acme', rowNumber: 21, stage: 'discovery',
    }]);
    const fresh = findItemById(item.id);
    if (!fresh) throw new Error('item missing');
    const runId = 'dr_manual_attested';
    const [source] = insertSources(item.id, [{
      url: 'https://acme.example/products/widget-12oz', confidence: 0.9, domain: 'acme.example',
      sourceMethod: 'sitemap_name', discoveryRunId: runId,
    }]);
    stubFetch(() => new Response('<html><body><h1>ACME Turbo Widget</h1></body></html>', { status: 200 }));
    const decision = await confirmOfficialPageCandidate({
      item: { ...fresh, stage: 'find_product_page' as never }, source, workspaceId,
      attestedProductAndVariant: true, expectedUpdatedAt: fresh.updatedAt, expectedDiscoveryRunId: runId,
    });
    expect(decision.evidenceKind).toBe('operator_name');
    expect(decision.sourceRunId).toBe(runId);
  });
});
