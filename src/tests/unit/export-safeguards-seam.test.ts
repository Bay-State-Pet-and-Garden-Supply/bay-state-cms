/**
 * Issue #355 slice — export safeguards workflow seam (criteria 3–8).
 *
 * Proves through the confirmed workflow/local dry-run seam (public interfaces
 * only): accepted draft → canonical XML codec → parsed XML parity, with
 * protected/unknown preservation and meaningful negative/boundary cases.
 * Isolated persistence (fresh temp DB per test); deterministic adapters;
 * fake CGI only (no live ShopSite calls of any kind).
 *
 * Slice 1 (RED): an accepted explicit clear ('') survives the codec as an
 * explicit empty element and round-trips back to '' (never resurrected from
 * preserved/default metadata).
 */
import { describe, it, expect } from 'bun:test';
import { isProtectedCatalogField } from '../../classification/classification-ownership';
import { ShopSiteProductCodec } from '../../shopsite/product-codec';
import type { Product } from '../../shared/types';

const NOW = '2026-08-01T12:00:00.000Z';

function product(overrides: Partial<Product> = {}): Product {
  return {
    schemaVersion: 1, id: 'p-export', sku: 'SKU-EXPORT', status: 'active',
    core: {
      name: 'Acme Chicken Dinner', price: '9.99', salePrice: null, description: 'Yummy kibble',
      inventory: { quantityOnHand: 5, lowStockThreshold: null, outOfStockLimit: null }, availability: 'instock',
      weight: '5 lb', taxable: true, media: { primary: null, additional: [] },
      seo: { fileName: 'acme.html', searchKeywords: 'k', googleProductCategory: null }, productOnPages: ['Dog Food'],
    },
    customFields: { ProductField23: 'Chicken', ProductField16: 'Acme' },
    shopsite: { productId: null, productGuid: null, xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null, source: { dbname: 'products', uniqueName: 'SKU' }, preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} } },
    metadata: { createdAt: NOW, updatedAt: NOW, archivedAt: null },
    ...overrides,
  } as Product;
}

describe('issue #355 export seam: codec clear preservation', () => {
  it("an accepted clear ('') emits an explicit empty element and round-trips back to ''", () => {
    const cleared = product({ customFields: { ProductField23: '', ProductField16: 'Acme' } });
    const encoded = ShopSiteProductCodec.encode(cleared);
    expect(encoded.warnings).toEqual([]);
    // Explicit empty element — the clear is ON THE WIRE, not an omission.
    expect(encoded.xml).toContain('<ProductField23></ProductField23>');

    const decoded = ShopSiteProductCodec.decodeOne(encoded.xml)!.product;
    expect(decoded.customFields['ProductField23']).toBe('');
    expect(decoded.customFields['ProductField16']).toBe('Acme');
  });

  it('protected Brand slot + unknown XML survive the round-trip byte-stable', () => {
    const withUnknown = product({
      shopsite: {
        productId: null, productGuid: null, xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null,
        source: { dbname: 'products', uniqueName: 'SKU' },
        preserved: { unknownElements: { CustomMystery: 'keep-me' }, advancedBlocks: {}, rawAttributes: {} },
      } as Product['shopsite'],
    });
    const encoded = ShopSiteProductCodec.encode(withUnknown);
    expect(encoded.xml).toContain('Acme');
    expect(encoded.xml).toContain('keep-me');

    const decoded = ShopSiteProductCodec.decodeOne(encoded.xml)!.product;
    expect(decoded.customFields['ProductField16']).toBe('Acme');
    expect(decoded.shopsite.preserved.unknownElements['CustomMystery']).toBe('keep-me');
  });
});

describe('issue #355 export seam: mapping-layer non-rerouting', () => {
  it('a semantic attribute mapped into the Brand slot is refused at apply (never overwrites Brand)', async () => {
    const { initDb, getDb } = await import('../../db/connection');
    const { runMigrations } = await import('../../db/migrations');
    const { insertWorkspace } = await import('../../db/repositories/workspace-repo');
    const { createRun: createRepositoryRun, completeRun } = await import('../../db/repositories/classification-run-repo');
    const { createConfigSnapshot, syncConfigToCache } = await import('../../db/repositories/classification-config-repo');
    const { buildRuntimeSnapshot, persistRuntimeSnapshot } = await import('../../classification/runtime-snapshot');
    const { submitProposalDecisions } = await import('../../classification/proposal-review-service');
    const { applyCatalogClassification } = await import('../../classification/catalog-product-application');
    const { writeProductFile } = await import('../../git/workspace-files');
    const { listChangeSetItems } = await import('../../db/repositories/change-set-repo');
    const { setTaxonomyFreezeForTests } = await import('../../classification/taxonomy-freeze');
    const { default: path } = await import('path');
    const { default: fs } = await import('fs');
    const { default: os } = await import('os');

    const WS_ID = 'ws-mapping-guard-seam';
    setTaxonomyFreezeForTests(false);
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mapping-guard-'));
    fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
    initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
    runMigrations();
    insertWorkspace({ id: WS_ID, name: 'seam', workspacePath, gitPath: '', createdAt: NOW, updatedAt: NOW, bootstrapStatus: 'complete', baselineCommit: null });

    // EVIL mapping: semantic flavor attribute routed into the Brand slot.
    const { saveClassificationConfig, loadClassificationConfig } = await import('../../classification/config-loader');
    saveClassificationConfig(workspacePath, {
      manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: NOW, updatedAt: NOW, fileVersions: {} },
      productTypes: [], attributes: [
        { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Chicken'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: 'Food' },
      ],
      attributeProfiles: [],
      attributeMappings: [
        { id: 'evil-map', attributeId: 'flavor', catalogField: 'ProductField16', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      ],
      curationTargets: [
        { id: 'flavor-target', kind: 'product_field', label: 'Flavor', enabled: true, selectionMode: 'single', attributeId: 'flavor', catalogField: 'ProductField16', optionSource: 'configured', required: false, mandatory: false, sortOrder: 1 },
      ],
      brands: [], guidance: [],
      modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only', textDataSharing: 'local_only' },
      dataSharing: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
    } as any);
    syncConfigToCache(WS_ID, loadClassificationConfig(workspacePath));

    const sku = 'SKU-REROUTE';
    const { computeProductHash } = await import('../../classification/catalog-product-source');
    const ref = createConfigSnapshot(WS_ID, loadClassificationConfig(workspacePath) as any);
    const snapshot = buildRuntimeSnapshot({ workspaceId: WS_ID, workspacePath, productSku: sku, config: loadClassificationConfig(workspacePath) as any, configSnapshotRef: { id: ref.id, hash: ref.hash, sourceCommit: null, createdAt: NOW }, sourceProductHash: null });
    persistRuntimeSnapshot(snapshot);
    const run = createRepositoryRun(WS_ID, sku, ref.id, snapshot.snapshotHash, { sourceKind: 'catalog_product' });
    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ['prop-flavor', run.id, sku, 'field_assignment', 'flavor', '"Chicken"', 0.9, 'pending', new Date().toISOString()],
    );
    completeRun(run.id, 'completed');
    const accept = submitProposalDecisions({ workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product', decisions: [{ proposalId: 'prop-flavor', decision: 'accepted' }] });
    expect(accept.ok).toBe(true);

    const draftProduct = product({ sku, customFields: { ProductField16: 'Acme', ProductField23: 'Beef' } });
    writeProductFile(workspacePath, draftProduct);
    getDb().run('UPDATE classification_runs SET source_product_hash = ? WHERE id = ?', [computeProductHash(draftProduct), run.id]);
    const result = await applyCatalogClassification(workspacePath, WS_ID, sku, run.id);
    // The rerouted write is refused; Brand survives byte-identical.
    expect(result.appliedFields).not.toContain('ProductField16');
    expect(result.skipped.some(s => s.proposalId === 'prop-flavor')).toBe(true);
    const items = listChangeSetItems(result.changeSetId);
    const draft = JSON.parse((items[0] as any).draftJson);
    expect(draft.customFields.ProductField16).toBe('Acme');
  });

  it('a mapping re-pointed after review cannot replay the frozen value into another field', async () => {
    const { initDb, getDb } = await import('../../db/connection');
    const { runMigrations } = await import('../../db/migrations');
    const { insertWorkspace } = await import('../../db/repositories/workspace-repo');
    const { createRun: createRepositoryRun, completeRun } = await import('../../db/repositories/classification-run-repo');
    const { createConfigSnapshot, syncConfigToCache } = await import('../../db/repositories/classification-config-repo');
    const { buildRuntimeSnapshot, persistRuntimeSnapshot } = await import('../../classification/runtime-snapshot');
    const { submitProposalDecisions } = await import('../../classification/proposal-review-service');
    const { applyCatalogClassification } = await import('../../classification/catalog-product-application');
    const { writeProductFile } = await import('../../git/workspace-files');
    const { listChangeSetItems } = await import('../../db/repositories/change-set-repo');
    const { setTaxonomyFreezeForTests } = await import('../../classification/taxonomy-freeze');
    const { default: path } = await import('path');
    const { default: fs } = await import('fs');
    const { default: os } = await import('os');

    const WS_ID = 'ws-mapping-currency-seam';
    setTaxonomyFreezeForTests(false);
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'mapping-currency-'));
    fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, 'store', 'classification'), { recursive: true });
    initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
    runMigrations();
    insertWorkspace({ id: WS_ID, name: 'seam', workspacePath, gitPath: '', createdAt: NOW, updatedAt: NOW, bootstrapStatus: 'complete', baselineCommit: null });

    const { saveClassificationConfig, loadClassificationConfig } = await import('../../classification/config-loader');
    const goodConfig: any = {
      manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: NOW, updatedAt: NOW, fileVersions: {} },
      productTypes: [], attributes: [
        { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Chicken'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: 'Food' },
      ],
      attributeProfiles: [],
      attributeMappings: [
        { id: 'flavor-map', attributeId: 'flavor', catalogField: 'ProductField23', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      ],
      curationTargets: [
        { id: 'flavor-target', kind: 'product_field', label: 'Flavor', enabled: true, selectionMode: 'single', attributeId: 'flavor', catalogField: 'ProductField23', optionSource: 'configured', required: false, mandatory: false, sortOrder: 1 },
      ],
      brands: [], guidance: [],
      modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only', textDataSharing: 'local_only' },
      dataSharing: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
    };
    saveClassificationConfig(workspacePath, goodConfig);
    syncConfigToCache(WS_ID, loadClassificationConfig(workspacePath));

    const sku = 'SKU-REPOINT';
    const { computeProductHash } = await import('../../classification/catalog-product-source');
    const ref = createConfigSnapshot(WS_ID, goodConfig);
    const snapshot = buildRuntimeSnapshot({ workspaceId: WS_ID, workspacePath, productSku: sku, config: goodConfig, configSnapshotRef: { id: ref.id, hash: ref.hash, sourceCommit: null, createdAt: NOW }, sourceProductHash: null });
    persistRuntimeSnapshot(snapshot);
    const run = createRepositoryRun(WS_ID, sku, ref.id, snapshot.snapshotHash, { sourceKind: 'catalog_product' });
    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      ['prop-flavor', run.id, sku, 'field_assignment', 'flavor', '"Chicken"', 0.9, 'pending', new Date().toISOString()],
    );
    completeRun(run.id, 'completed');
    const accept = submitProposalDecisions({ workspaceId: WS_ID, productSku: sku, runId: run.id, sourceKind: 'catalog_product', decisions: [{ proposalId: 'prop-flavor', decision: 'accepted' }] });
    expect(accept.ok).toBe(true);

    // Re-point the LIVE mapping after review (simulates a mapping edit):
    // the frozen accepted value must not replay into the new field.
    getDb().run(`UPDATE classification_attribute_mappings SET catalog_field = ? WHERE workspace_id = ? AND attribute_id = ?`, ['ProductField24', WS_ID, 'flavor']);

    const draftProduct = product({ sku, customFields: { ProductField23: 'Beef', ProductField24: 'Old24' } });
    writeProductFile(workspacePath, draftProduct);
    getDb().run('UPDATE classification_runs SET source_product_hash = ? WHERE id = ?', [computeProductHash(draftProduct), run.id]);
    const result = await applyCatalogClassification(workspacePath, WS_ID, sku, run.id);
    expect(result.appliedFields).not.toContain('ProductField24');
    expect(result.skipped.some(s => s.reason.includes('mapping_changed'))).toBe(true);
    const items = listChangeSetItems(result.changeSetId);
    const draft = JSON.parse((items[0] as any).draftJson);
    expect(draft.customFields.ProductField23).toBe('Beef');
    expect(draft.customFields.ProductField24).toBe('Old24');
  });

  it('a semantic attribute mapped into a misrouted live slot (PF13 Upsell) is refused at apply', () => {
    // Certified live purpose (2026-10-15 screenshot): PF13 is `Upsell - Lightbox`,
    // PF14 unnamed, PF8 `Custom Tab #1`, PF1 unnamed — none may take classification output.
    for (const slot of ['ProductField13', 'ProductField14', 'ProductField8', 'ProductField1']) {
      expect(isProtectedCatalogField(slot, 'category', [])).toBe(true);
    }
    // Certified PF16–32 slots stay writable (guard is slot-scoped, not blanket).
    expect(isProtectedCatalogField('ProductField24', 'category', [])).toBe(false);
  });
});

describe('issue #355 export seam: local dry-run with fake CGI only', () => {
  it('draft with accepted clear + Brand + unknown XML exports to file and uploads through a fake CGI with parity', async () => {
    const { default: path } = await import('path');
    const { default: fs } = await import('fs');
    const { default: os } = await import('os');
    const { createExportPackage } = await import('../../shopsite/export-package');

    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'export-dryrun-'));
    const draft = product({
      sku: 'SKU-DRYRUN',
      customFields: { ProductField23: '', ProductField16: 'Acme' },
      shopsite: {
        productId: null, productGuid: null, xmlVersion: '15.0', lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null,
        source: { dbname: 'products', uniqueName: 'SKU' },
        preserved: { unknownElements: { CustomMystery: 'keep-me' }, advancedBlocks: {}, rawAttributes: {} },
      } as Product['shopsite'],
    });

    // Offline export path: draft → XML file. No network of any kind.
    const pkg = await createExportPackage(workspacePath, 'cs-dryrun', [draft], { changeSetTitle: 'dry run' });
    expect(pkg.productCount).toBe(1);
    const xml = fs.readFileSync(pkg.xmlPath, 'utf-8');
    expect(xml).toContain('<ProductField23></ProductField23>');
    expect(xml).toContain('Acme');
    expect(xml).toContain('keep-me');

    // File → decode parity: clear stays '', Brand + unknown survive.
    const decoded = ShopSiteProductCodec.decodeOne(xml)!.product;
    expect(decoded.customFields['ProductField23']).toBe('');
    expect(decoded.customFields['ProductField16']).toBe('Acme');
    expect(decoded.shopsite.preserved.unknownElements['CustomMystery']).toBe('keep-me');

    // Fake CGI: stub fetch, upload the file bytes, assert wire contents.
    // No live ShopSite call exists in this path (fetch is fully stubbed).
    const uploads: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
      const url = String(input);
      const body = typeof init?.body === 'string' ? init.body : '';
      if (url.includes('dbupload.cgi')) {
        uploads.push(body);
        return new Response('<html><body>Upload OK</body></html>', { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    }) as unknown as typeof fetch;
    try {
      const res = await fetch('https://fake-store.example.com/dbupload.cgi', { method: 'POST', body: xml });
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toContain('<ProductField23></ProductField23>');
    expect(uploads[0]).toContain('Acme');
  });
});
