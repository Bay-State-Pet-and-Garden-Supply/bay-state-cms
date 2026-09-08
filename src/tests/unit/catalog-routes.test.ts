import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import catalogRoutes from '../../server/routes/catalog-routes';
import { getCurrentWorkspace } from '../../server/services/workspace-service';
import { listRegistry } from '../../db/repositories/field-registry-repo';
import { listPages } from '../../db/repositories/page-repo';
import { getDb } from '../../db/connection';
import { loadRuntimeConfig } from '../../classification/config-loader';

vi.mock('@/server/services/workspace-service', () => ({
  getCurrentWorkspace: vi.fn(),
}));

vi.mock('@/db/repositories/field-registry-repo', () => ({
  listRegistry: vi.fn(),
}));

vi.mock('@/db/repositories/page-repo', () => ({
  listPages: vi.fn(),
}));

vi.mock('@/db/connection', () => ({
  getDb: vi.fn(),
}));

vi.mock('@/classification/config-loader', () => ({
  loadRuntimeConfig: vi.fn(),
}));

const workspace = {
  id: 'ws-1',
  name: 'Test Store',
  workspacePath: '/tmp/test-store',
  gitPath: '/tmp/test-store/.git',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
  bootstrapStatus: 'complete',
  baselineCommit: 'abc123',
};

const registryRows = [
  {
    id: 'field-24', workspaceId: 'ws-1', xmlField: 'ProductField24', label: 'Flavor', kind: 'custom', dataType: 'string', editable: true, required: false, uiGroup: 'Custom Fields', sampleValuesJson: null, createdAt: '', updatedAt: '',
  },
  {
    id: 'field-25', workspaceId: 'ws-1', xmlField: 'ProductField25', label: 'ProductField25', kind: 'custom', dataType: 'string', editable: true, required: false, uiGroup: 'Custom Fields', sampleValuesJson: null, createdAt: '', updatedAt: '',
  },
  {
    id: 'field-26', workspaceId: 'ws-1', xmlField: 'ProductField26', label: 'Legacy Field', kind: 'custom', dataType: 'string', editable: true, required: false, uiGroup: 'Custom Fields', sampleValuesJson: null, createdAt: '', updatedAt: '',
  },
];

const pageRows = [
  { id: 'page-dog', name: 'Dog Food', fileName: 'dog-food.html', parentId: null, pageHash: 'hash-1', lastSyncedAt: '2026-02-01T00:00:00.000Z', createdAt: '', updatedAt: '' },
  { id: 'page-dry', name: 'Dry Dog Food', fileName: 'dry-dog-food.html', parentId: 'page-dog', pageHash: 'hash-2', lastSyncedAt: '2026-02-01T00:00:00.000Z', createdAt: '', updatedAt: '' },
];

const config = {
  manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: '', updatedAt: '', fileVersions: {} },
  productTypes: [{ id: 'dog-food', name: 'Dog Food', description: null, attributeProfileId: 'dog-food-profile', oldIdAliases: [] }],
  attributes: [
    { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Chicken', 'Beef'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: null },
    { id: 'life-stage', name: 'Life Stage', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: [], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: null },
    { id: 'legacy-attr', name: 'Legacy Attribute', description: null, valueMode: 'freeText', canonicalUnit: null, allowedValues: [], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, group: null },
  ],
  attributeProfiles: [{ id: 'dog-food-profile', productTypeId: 'dog-food', name: 'Dog Food Profile', attributes: [{ attributeId: 'flavor', required: false, cardinality: 'single', applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] }] }],
  attributeMappings: [
    { id: 'flavor-map', attributeId: 'flavor', catalogField: 'ProductField24', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
    { id: 'legacy-map', attributeId: 'legacy-attr', catalogField: 'ProductField26', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: true },
  ],
  curationTargets: [{ id: 'target-flavor', kind: 'product_field', label: 'Flavor', enabled: true, mandatory: false, selectionMode: 'single', attributeId: 'flavor', catalogField: 'ProductField24', optionSource: 'live_store', required: false, sortOrder: 0 }],
  brands: [],
  guidance: [],
  modelPolicy: { defaultProvider: 'ollama', defaultModel: 'qwen2.5vl:latest', stageOverrides: {}, imageDataSharing: 'local_only', textDataSharing: 'local_only' },
  dataSharing: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
};

function fieldFromSql(sql: string): string | null {
  return sql.match(/\$\.([A-Za-z0-9_]+)/)?.[1] ?? null;
}

function valuesForField(field: string | null): string[] {
  if (field === 'ProductField24') return ['Chicken', 'Beef', 'Chicken'];
  if (field === 'ProductField25') return ['Needs label'];
  return [];
}

function skuRowsFor(field: string | null, value?: unknown): Array<{ sku: string }> {
  if (field !== 'ProductField24') return [];
  if (value === 'Chicken') return [{ sku: 'SKU-1' }, { sku: 'SKU-3' }];
  if (value === 'Beef') return [{ sku: 'SKU-2' }];
  return [{ sku: 'SKU-1' }, { sku: 'SKU-2' }, { sku: 'SKU-3' }];
}

const fakeDb = {
  query: vi.fn((sql: string) => ({
    get: () => {
      if (sql.includes('FROM product_index') && !sql.includes('WHERE')) return { count: 3 };
      if (sql.includes('FROM page_index')) return { count: 2 };
      if (sql.includes('COUNT(*) as count FROM product_index') && sql.includes('WHERE json_extract')) {
        const field = fieldFromSql(sql);
        return { count: field === 'ProductField24' ? 0 : 2 };
      }
      return { count: 0 };
    },
    all: (...params: unknown[]) => {
      if (sql.includes('SELECT json_extract')) {
        return valuesForField(fieldFromSql(sql)).map(value => ({ value }));
      }
      if (sql.includes('SELECT sku FROM product_index')) {
        return skuRowsFor(fieldFromSql(sql), params[0]);
      }
      if (sql.includes('SELECT page_id, COUNT(*) as count FROM product_pages')) {
        return [{ page_id: 'page-dog', count: 2 }];
      }
      if (sql.includes('SELECT page_name, COUNT(*) as count FROM product_pages')) {
        return [{ page_name: 'Dog Food', count: 3 }, { page_name: 'Legacy Page', count: 1 }];
      }
      if (sql.includes('SELECT DISTINCT pp.page_name')) {
        return [{ page_name: 'Legacy Page', count: 1 }];
      }
      return [];
    },
  })),
};

function makeApp() {
  const app = new Hono();
  app.route('/api', catalogRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentWorkspace).mockReturnValue(workspace as never);
  vi.mocked(listRegistry).mockReturnValue(registryRows as never);
  vi.mocked(listPages).mockReturnValue(pageRows as never);
  vi.mocked(loadRuntimeConfig).mockReturnValue(config as never);
  vi.mocked(getDb).mockReturnValue(fakeDb as never);
});

describe('catalog schema routes', () => {
  it('summarizes live Catalog Fields, Category Pages, and mappings', async () => {
    const res = await makeApp().request('/api/catalog/schema-summary');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({
      productCount: 3,
      categoryPageCount: 2,
      catalogFieldCount: 3,
      unlabeledFieldCount: 1,
      unmappedAttributeCount: 1,
      staleMappingCount: 1,
      lastPullAt: workspace.updatedAt,
    });
  });

  it('returns consistent field list and field detail enrichment', async () => {
    const app = makeApp();
    const listRes = await app.request('/api/catalog/fields');
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();

    const flavor = listBody.fields.find((f: { xmlField: string }) => f.xmlField === 'ProductField24');
    expect(flavor).toMatchObject({
      label: 'Flavor',
      nonEmptyCount: 3,
      distinctCount: 2,
      inferredValueMode: 'measured',
      mappedAttributeId: 'flavor',
      isCurationTarget: true,
      isStale: false,
      warning: null,
    });

    const unlabeled = listBody.fields.find((f: { xmlField: string }) => f.xmlField === 'ProductField25');
    expect(unlabeled.warning).toBe('Unlabeled field');

    const stale = listBody.fields.find((f: { xmlField: string }) => f.xmlField === 'ProductField26');
    expect(stale).toMatchObject({ mappedAttributeId: 'legacy-attr', isStale: true, warning: 'Stale mapping — field not in latest pull' });

    const detailRes = await app.request('/api/catalog/fields/ProductField24');
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    expect(detail).toMatchObject({
      xmlField: 'ProductField24',
      mappedAttributeId: 'flavor',
      isCurationTarget: true,
      isStale: false,
      warning: null,
      emptyCount: 0,
      emptyRate: 0,
      affectedExampleSkus: ['SKU-1', 'SKU-2', 'SKU-3'],
    });
    expect(detail.topValues[0]).toMatchObject({ value: 'Chicken', frequency: 2, skus: ['SKU-1', 'SKU-3'] });

    const staleDetailRes = await app.request('/api/catalog/fields/ProductField26');
    const staleDetail = await staleDetailRes.json();
    expect(staleDetail).toMatchObject({ mappedAttributeId: 'legacy-attr', isStale: true, warning: 'Stale mapping — field not in latest pull' });
  });

  it('returns Category Page tree with stable identities and product counts', async () => {
    const res = await makeApp().request('/api/catalog/pages/tree');
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.pages).toHaveLength(1);
    expect(body.pages[0]).toMatchObject({ id: 'page-dog', name: 'Dog Food', fileName: 'dog-food.html', productCount: 2 });
    expect(body.pages[0].children[0]).toMatchObject({ id: 'page-dry', name: 'Dry Dog Food', parentId: 'page-dog' });
  });

  it('returns Attribute Mappings and Schema Health findings', async () => {
    const app = makeApp();
    const mappingsRes = await app.request('/api/catalog/mappings');
    expect(mappingsRes.status).toBe(200);
    const mappingsBody = await mappingsRes.json();

    expect(mappingsBody.mappings[0]).toMatchObject({
      id: 'flavor-map',
      attributeId: 'flavor',
      attributeName: 'Flavor',
      catalogField: 'ProductField24',
      isStale: false,
      usedByProductTypes: ['Dog Food'],
    });

    const healthRes = await app.request('/api/catalog/schema-health');
    expect(healthRes.status).toBe(200);
    const healthBody = await healthRes.json();
    const codes = healthBody.findings.map((f: { code: string }) => f.code);

    expect(codes).toEqual(expect.arrayContaining([
      'UNLABELED_FIELD',
      'STALE_MAPPING',
      'UNMAPPED_ATTRIBUTE',
      'NAMEONLY_PAGE_ASSIGNMENT',
    ]));
    expect(healthBody.summary).toMatchObject({ blockers: 0, warnings: 3, infos: 1 });
  });
});
