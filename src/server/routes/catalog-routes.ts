import { Hono } from 'hono';
import { getCurrentWorkspace } from '../services/workspace-service';
import { listRegistry } from '../../db/repositories/field-registry-repo';
import { listPages } from '../../db/repositories/page-repo';
import { getDb } from '../../db/connection';
import { loadRuntimeConfig } from '../../classification/config-loader';
import { composeMerchandisingFieldSpecs } from '../../classification/merchandising-field-spec';
import { projectCatalogFieldSummaries } from '../../classification/merchandising-field-spec-projections';
import type {
  ConfigurationReadInput,
  FieldObservations,
  RegistryMetadata,
} from '../../shared/schemas/merchandising-field-spec';

const route = new Hono();

/**
 * Compute field stats from product_index.custom_fields.
 * Returns a map of xmlField → { nonEmptyCount, distinctCount, sampleValues, topValues }.
 */
function computeFieldStats(xmlFields: string[]): Record<string, {
  nonEmptyCount: number;
  distinctCount: number;
  sampleValues: string[];
  topValues: Array<{ value: string; frequency: number }>;
}> {
  if (xmlFields.length === 0) return {};
  const db = getDb();
  const stats: Record<string, any> = {};
  for (const field of xmlFields) {
    if (!/^[a-zA-Z0-9_]+$/.test(field)) continue;
    try {
      const rows = db.query(`
        SELECT json_extract(custom_fields, '$.${field}') as value
        FROM product_index
        WHERE value IS NOT NULL AND value != ''
      `).all() as Array<{ value: string | null }>;

      const values: string[] = rows.map(r => r.value).filter((v): v is string => v !== null);
      const distinct = [...new Set(values)];
      const frequencyMap = new Map<string, number>();
      for (const v of values) {
        frequencyMap.set(v, (frequencyMap.get(v) || 0) + 1);
      }
      const topValues = [...frequencyMap.entries()]
        .map(([value, frequency]) => ({ value, frequency }))
        .sort((a, b) => b.frequency - a.frequency)
        .slice(0, 20);

      stats[field] = {
        nonEmptyCount: values.length,
        distinctCount: distinct.length,
        sampleValues: distinct.slice(0, 10),
        topValues,
      };
    } catch (e) {
      console.error(`[CatalogRoutes] Failed to compute stats for ${field}:`, e);
      stats[field] = { nonEmptyCount: 0, distinctCount: 0, sampleValues: [], topValues: [] };
    }
  }
  return stats;
}


/**
 * GET /api/catalog/schema-summary
 * Aggregate counts from field_registry, product_index, page_index, and classification config.
 */
route.get('/catalog/schema-summary', (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) return c.json({ error: 'No workspace loaded.' }, 400);
  const db = getDb();

  // Product count
  const prodRow = db.query('SELECT COUNT(*) as count FROM product_index').get() as { count: number } | undefined;
  const productCount = prodRow?.count ?? 0;

  // Category page count
  const pageRow = db.query('SELECT COUNT(*) as count FROM page_index').get() as { count: number } | undefined;
  const categoryPageCount = pageRow?.count ?? 0;

  // Catalog field (registry) count
  const registry = listRegistry(ws.id);
  const catalogFieldCount = registry.length;
  const unlabeledFieldCount = registry.filter(r =>
    r.kind === 'custom' && (!r.label || r.label === r.xmlField)
  ).length;

  // Classification config stats
  let unmappedAttributeCount = 0;
  let staleMappingCount = 0;
  let fieldsMissingFromLatestPull: string[] = [];
  try {
    const config = loadRuntimeConfig(ws.workspacePath, ws.id);
    unmappedAttributeCount = config.attributes.filter(a =>
      !config.attributeMappings.some(m => m.attributeId === a.id)
    ).length;
    staleMappingCount = config.attributeMappings.filter(m => m.isStale).length;

    // Fields in registry that are not ProductField* — these are stale candidates
    const registryFields = new Set(registry.map(r => r.xmlField));
    fieldsMissingFromLatestPull = config.attributeMappings
      .filter(m => m.catalogField && !registryFields.has(m.catalogField))
      .map(m => m.catalogField);
  } catch {
    // Classification config may not exist yet
  }

  return c.json({
    lastPullAt: ws.baselineCommit ? ws.updatedAt : null,
    productCount,
    categoryPageCount,
    catalogFieldCount,
    unlabeledFieldCount,
    unmappedAttributeCount,
    staleMappingCount,
    fieldsMissingFromLatestPull,
    productsMissingRequiredMappedField: 0, // computed on demand in schema-health
  });
});

/**
 * GET /api/catalog/fields
 * Returns registry entries enriched with computed stats and mapping info.
 */
route.get('/catalog/fields', (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) return c.json({ error: 'No workspace loaded.' }, 400);

  const rawRegistry = listRegistry(ws.id);
  const xmlFields = rawRegistry.map(r => r.xmlField);
  const stats = computeFieldStats(xmlFields);

  let configInput: ConfigurationReadInput;
  try {
    const config = loadRuntimeConfig(ws.workspacePath, ws.id);
    configInput = { status: 'complete', config };
  } catch {
    configInput = { status: 'unavailable', reason: 'source_failed' };
  }

  const registry: RegistryMetadata[] = rawRegistry.map(r => ({
    xmlField: r.xmlField,
    label: r.label,
    kind: r.kind,
    dataType: r.dataType,
    editable: r.editable,
    required: r.required,
    uiGroup: r.uiGroup,
    sampleValuesJson: r.sampleValuesJson,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));

  const observations: Record<string, FieldObservations> = {};
  for (const field of xmlFields) {
    const fieldStats = stats[field];
    observations[field] = {
      liveOptions: { status: 'unavailable', reason: 'not_loaded' },
      catalogStats: fieldStats
        ? {
            status: 'available',
            data: {
              nonEmptyCount: fieldStats.nonEmptyCount,
              distinctCount: fieldStats.distinctCount,
              sampleValues: fieldStats.sampleValues,
              topValues: fieldStats.topValues,
            },
          }
        : null,
    };
  }

  const model = composeMerchandisingFieldSpecs({
    configuration: configInput,
    registry: { status: 'available', data: registry },
    observations,
  });

  const fields = projectCatalogFieldSummaries(model, 'catalog');
  return c.json({ fields });
});

/**
 * GET /api/catalog/fields/:xmlField
 * Detailed view of one field with value histogram and affected SKUs.
 */
route.get('/catalog/fields/:xmlField', (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) return c.json({ error: 'No workspace loaded.' }, 400);
  const xmlField = c.req.param('xmlField');

  const rawRegistry = listRegistry(ws.id);
  const entry = rawRegistry.find(r => r.xmlField === xmlField);
  if (!entry) return c.json({ error: 'Field not found in registry.' }, 404);

  const stats = computeFieldStats([xmlField]);
  const fieldStats = stats[xmlField] ?? { nonEmptyCount: 0, distinctCount: 0, sampleValues: [], topValues: [] };

  let configInput: ConfigurationReadInput;
  try {
    const config = loadRuntimeConfig(ws.workspacePath, ws.id);
    configInput = { status: 'complete', config };
  } catch {
    configInput = { status: 'unavailable', reason: 'source_failed' };
  }

  const regMetadata: RegistryMetadata = {
    xmlField: entry.xmlField,
    label: entry.label,
    kind: entry.kind,
    dataType: entry.dataType,
    editable: entry.editable,
    required: entry.required,
    uiGroup: entry.uiGroup,
    sampleValuesJson: entry.sampleValuesJson,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };

  const observations: Record<string, FieldObservations> = {
    [xmlField]: {
      liveOptions: { status: 'unavailable', reason: 'not_loaded' },
      catalogStats: {
        status: 'available',
        data: {
          nonEmptyCount: fieldStats.nonEmptyCount,
          distinctCount: fieldStats.distinctCount,
          sampleValues: fieldStats.sampleValues,
          topValues: fieldStats.topValues,
        },
      },
    },
  };

  const model = composeMerchandisingFieldSpecs({
    configuration: configInput,
    registry: { status: 'available', data: [regMetadata] },
    observations,
  });

  const [summary] = projectCatalogFieldSummaries(model, 'catalog');

  // Get empty count & total
  let emptyCount = 0;
  let totalCount = 0;
  if (/^[a-zA-Z0-9_]+$/.test(xmlField)) {
    try {
      const db = getDb();
      const totalRow = db.query('SELECT COUNT(*) as count FROM product_index').get() as { count: number };
      totalCount = totalRow?.count ?? 0;
      const emptyRow = db.query(`
        SELECT COUNT(*) as count FROM product_index
        WHERE json_extract(custom_fields, '$.${xmlField}') IS NULL OR json_extract(custom_fields, '$.${xmlField}') = ''
      `).get() as { count: number };
      emptyCount = emptyRow?.count ?? 0;
    } catch { /* ignore */ }
  }

  // Get example SKUs for top values
  const exampleSkus: string[] = [];
  if (/^[a-zA-Z0-9_]+$/.test(xmlField)) {
    try {
      const db = getDb();
      const exRows = db.query(`
        SELECT sku FROM product_index
        WHERE json_extract(custom_fields, '$.${xmlField}') IS NOT NULL AND json_extract(custom_fields, '$.${xmlField}') != ''
        LIMIT 10
      `).all() as Array<{ sku: string }>;
      exampleSkus.push(...exRows.map(r => r.sku));
    } catch { /* ignore */ }
  }

  // Build topValues with SKUs
  const topValuesWithSkus: Array<{ value: string; frequency: number; skus: string[] }> = [];
  for (const tv of fieldStats.topValues) {
    const skuList: string[] = [];
    try {
      if (/^[a-zA-Z0-9_]+$/.test(xmlField)) {
        const db = getDb();
        const skuRows = db.query(`
          SELECT sku FROM product_index
          WHERE json_extract(custom_fields, '$.${xmlField}') = ?
          LIMIT 5
        `).all(tv.value) as Array<{ sku: string }>;
        skuList.push(...skuRows.map(r => r.sku));
      }
    } catch { /* ignore */ }
    topValuesWithSkus.push({ ...tv, skus: skuList });
  }

  return c.json({
    xmlField: summary.xmlField,
    label: summary.label,
    kind: summary.kind,
    dataType: summary.dataType,
    uiGroup: summary.uiGroup,
    nonEmptyCount: summary.nonEmptyCount,
    distinctCount: summary.distinctCount,
    inferredValueMode: summary.inferredValueMode,
    mappedAttributeId: summary.mappedAttributeId,
    isCurationTarget: summary.isCurationTarget,
    isStale: summary.isStale,
    warning: summary.warning,
    sampleValues: fieldStats.sampleValues,
    topValues: topValuesWithSkus,
    emptyCount,
    emptyRate: totalCount > 0 ? emptyCount / totalCount : 0,
    affectedExampleSkus: exampleSkus,
  });
});

/**
 * GET /api/catalog/pages/tree
 * Returns pages in a tree structure based on parentId.
 */
route.get('/catalog/pages/tree', (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) return c.json({ error: 'No workspace loaded.' }, 400);
  const db = getDb();

  const pages = listPages();
  const pageProductCounts = new Map<string, number>();
  try {
    const countRows = db.query(`
      SELECT page_id, COUNT(*) as count FROM product_pages
      WHERE page_id IS NOT NULL
      GROUP BY page_id
    `).all() as Array<{ page_id: string; count: number }>;
    for (const row of countRows) {
      pageProductCounts.set(row.page_id, row.count);
    }
  } catch { /* product_pages table may not have counts */ }

  // Also get name-based counts for pages without page_id assignments
  const nameCounts = new Map<string, number>();
  try {
    const nameRows = db.query(`
      SELECT page_name, COUNT(*) as count FROM product_pages
      GROUP BY page_name
    `).all() as Array<{ page_name: string; count: number }>;
    for (const row of nameRows) {
      nameCounts.set(row.page_name, row.count);
    }
  } catch { /* ignore */ }

  // Build children map
  const childrenMap = new Map<string | null, typeof pages>();
  for (const page of pages) {
    const parentKey = page.parentId ?? null;
    if (!childrenMap.has(parentKey)) childrenMap.set(parentKey, []);
    childrenMap.get(parentKey)!.push(page);
  }

  function buildTree(parentId: string | null): any[] {
    const kids = childrenMap.get(parentId) ?? [];
    return kids.map(p => ({
      id: p.id,
      name: p.name,
      fileName: p.fileName,
      parentId: p.parentId,
      productCount: pageProductCounts.get(p.id) ?? nameCounts.get(p.name) ?? 0,
      lastSyncedAt: p.lastSyncedAt,
      children: buildTree(p.id),
    }));
  }

  const tree = buildTree(null);
  return c.json({ pages: tree });
});

/**
 * GET /api/catalog/mappings
 * Returns attribute mappings joined with attribute names and affected product types.
 */
route.get('/catalog/mappings', (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) return c.json({ error: 'No workspace loaded.' }, 400);

  try {
    const config = loadRuntimeConfig(ws.workspacePath, ws.id);
    const attrNames = new Map(config.attributes.map(a => [a.id, a.name]));

    // Build productType membership for each attribute
    const attrToTypes = new Map<string, string[]>();
    for (const pt of config.productTypes) {
      const profile = config.attributeProfiles.find(ap => ap.id === pt.attributeProfileId);
      if (profile) {
        for (const pa of profile.attributes) {
          if (!attrToTypes.has(pa.attributeId)) attrToTypes.set(pa.attributeId, []);
          attrToTypes.get(pa.attributeId)!.push(pt.name);
        }
      }
    }

    const mappings = config.attributeMappings.map(m => ({
      id: m.id,
      attributeId: m.attributeId,
      attributeName: attrNames.get(m.attributeId) ?? m.attributeId,
      catalogField: m.catalogField,
      serialization: m.serialization,
      isStale: m.isStale,
      usedByProductTypes: attrToTypes.get(m.attributeId) ?? [],
    }));

    return c.json({ mappings });
  } catch {
    return c.json({ mappings: [] });
  }
});

/**
 * GET /api/catalog/schema-health
 * Aggregates schema health findings.
 */
route.get('/catalog/schema-health', (c) => {
  const ws = getCurrentWorkspace();
  if (!ws) return c.json({ error: 'No workspace loaded.' }, 400);
  const db = getDb();

  const findings: Array<{
    id: string;
    severity: 'blocker' | 'warning' | 'info';
    code: string;
    message: string;
    fieldPath?: string | null;
    relatedTab: 'overview' | 'fields' | 'types' | 'pages' | 'health';
    relatedId?: string;
  }> = [];

  const registry = listRegistry(ws.id);

  // Unlabeled ProductField* entries
  for (const r of registry) {
    if (r.kind === 'custom' && (!r.label || r.label === r.xmlField)) {
      findings.push({
        id: `unlabeled-${r.xmlField}`,
        severity: 'warning',
        code: 'UNLABELED_FIELD',
        message: `Field "${r.xmlField}" has no descriptive label.`,
        fieldPath: r.xmlField,
        relatedTab: 'fields',
        relatedId: r.xmlField,
      });
    }
  }

  // Stale attribute mappings
  try {
    const config = loadRuntimeConfig(ws.workspacePath, ws.id);
    for (const m of config.attributeMappings) {
      if (m.isStale) {
        findings.push({
          id: `stale-mapping-${m.id}`,
          severity: 'warning',
          code: 'STALE_MAPPING',
          message: `Attribute mapping "${m.attributeId}" → "${m.catalogField}" is stale (field not in latest ShopSite pull).`,
          fieldPath: m.catalogField,
          relatedTab: 'types',
          relatedId: m.id,
        });
      }
    }

    // Unmapped attributes
    for (const attr of config.attributes) {
      const hasMapping = config.attributeMappings.some(m => m.attributeId === attr.id);
      if (!hasMapping) {
        findings.push({
          id: `unmapped-attr-${attr.id}`,
          severity: 'info',
          code: 'UNMAPPED_ATTRIBUTE',
          message: `Product Attribute "${attr.name}" (${attr.id}) has no Catalog Field mapping.`,
          relatedTab: 'types',
          relatedId: attr.id,
        });
      }
    }
  } catch { /* no config yet */ }

  // Name-only page assignments (no page_id)
  try {
    const nameOnlyRows = db.query(`
      SELECT DISTINCT pp.page_name, COUNT(*) as count
      FROM product_pages pp
      WHERE pp.page_id IS NULL
      GROUP BY pp.page_name
    `).all() as Array<{ page_name: string; count: number }>;
    for (const row of nameOnlyRows) {
      findings.push({
        id: `nameonly-page-${row.page_name}`,
        severity: 'warning',
        code: 'NAMEONLY_PAGE_ASSIGNMENT',
        message: `Page assignment "${row.page_name}" uses name-only identity (no page_id). Affects ${row.count} product(s).`,
        relatedTab: 'pages',
      });
    }
  } catch { /* product_pages not yet migrated */ }

  return c.json({
    findings,
    summary: {
      blockers: findings.filter(f => f.severity === 'blocker').length,
      warnings: findings.filter(f => f.severity === 'warning').length,
      infos: findings.filter(f => f.severity === 'info').length,
    },
  });
});

export default route;
