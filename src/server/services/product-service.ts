import { randomUUID } from 'node:crypto';
import { deterministicStringify, hashJson } from '../../git/deterministic-json';
import { readProductFile } from '../../git/workspace-files';
import { listProducts } from '../../db/repositories/product-index-repo';
import {
  findActiveChangeSet, upsertChangeSetItem, listChangeSetItems,
} from '../../db/repositories/change-set-repo';
import { findWorkspace } from '../../db/repositories/workspace-repo';
import { createChangeSet } from '../../db/repositories/change-set-repo';
import { clearValidationResultsForScope } from '../../db/repositories/validation-repo';
import { validateProduct } from '../../validation/product-validation';
import { getDb } from '../../db/connection';
import type { Product, ProductOperation } from '../../shared/types';
import type { ProductIndexRow } from '../../db/repositories/product-index-repo';


// fallow-ignore-next-line unused-type
export interface DraftOverlay {
  changeSetId: string;
  sku: string;
  operation: ProductOperation;
  draftJson: Product;
  draftHash: string;
}

/**
 * Get the approved product with any active draft overlay applied.
 */
export function getProductWithDraft(workspaceId: string, workspacePath: string, sku: string): {
  approved: Product | null;
  draft: DraftOverlay | null;
  merged: Product | null;
} {
  const approved = readProductFile(workspacePath, sku);
  const activeChangeSet = findActiveChangeSet(workspaceId);
  let draft: DraftOverlay | null = null;

  if (activeChangeSet) {
    const items = listChangeSetItems(activeChangeSet.id);
    const item = items.find(i => i.sku === sku && i.operation !== 'discarded');
    if (item) {
      const draftProduct = JSON.parse(item.draftJson) as Product;
      draft = {
        changeSetId: activeChangeSet.id,
        sku: item.sku,
        operation: item.operation as ProductOperation,
        draftJson: draftProduct,
        draftHash: item.draftHash,
      };
    }
  }

  const merged = draft ? draft.draftJson : approved;
  return { approved, draft, merged };
}

/**
 * List products from index with optional filters.
 */
export function listProductIndex(filter?: {
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
  minPrice?: string;
  maxPrice?: string;
  inventoryStatus?: string;
  customFilters?: Record<string, string>;
}): { products: ProductIndexRow[]; total: number } {
  return listProducts(filter);
}

/**
 * Autosave a product draft into the active change set.
 * Does NOT write to Git or product files.
 */
export function autosaveDraft(
  workspaceId: string,
  workspacePath: string,
  sku: string,
  draftChanges: Partial<Product>,
  operation?: ProductOperation,
): { changeSetId: string; draftHash: string } {
  const approved = readProductFile(workspacePath, sku);
  const baseProduct = approved ?? createEmptyProduct(sku);
  const now = new Date().toISOString();
  const draftProduct: Product = {
    ...baseProduct,
    ...draftChanges,
    status: operation === 'archive' ? 'archived' : (draftChanges.status ?? baseProduct.status),
    core: { ...baseProduct.core, ...(draftChanges.core ?? {}) },
    customFields: { ...baseProduct.customFields, ...(draftChanges.customFields ?? {}) },
    shopsite: { ...baseProduct.shopsite, ...(draftChanges.shopsite ?? {}) },
    metadata: {
      ...baseProduct.metadata,
      ...(draftChanges.metadata ?? {}),
      updatedAt: now,
      archivedAt: operation === 'archive' ? now : (draftChanges.metadata?.archivedAt ?? baseProduct.metadata.archivedAt),
    },
  };

  const draftHash = hashJson(draftProduct);
  const draftJsonStr = deterministicStringify(draftProduct);

  // Find or create active change set
  let activeCs = findActiveChangeSet(workspaceId);
  if (!activeCs) {
    const ws = findWorkspace();
    const baseCommit = ws?.baselineCommit ?? 'unknown';
    activeCs = createChangeSet({ workspaceId, title: `Edit ${sku}`, baseCommit });
  }

  upsertChangeSetItem({
    changeSetId: activeCs.id,
    sku,
    operation: operation ?? (approved ? 'update' : 'create'),
    draftJson: draftJsonStr,
    baseJson: approved ? deterministicStringify(approved) : null,
    draftHash,
  });

  return { changeSetId: activeCs.id, draftHash };
}

function createEmptyProduct(sku: string): Product {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: randomUUID(),
    sku,
    status: 'draft',
    core: {
      name: '', price: null, salePrice: null, description: null,
      inventory: { quantityOnHand: null, lowStockThreshold: null, outOfStockLimit: null },
      availability: null, weight: null, taxable: true,
      media: { primary: null, additional: [] },
      seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
      productOnPages: [],
    },
    customFields: {},
    shopsite: {
      productId: null, productGuid: null, xmlVersion: '15.0',
      lastPulledAt: null, lastRemoteHash: null, lastSyncedAt: null,
      source: { dbname: 'products', uniqueName: 'SKU' },
      preserved: { unknownElements: {}, advancedBlocks: {}, rawAttributes: {} },
    },
    metadata: { createdAt: now, updatedAt: now, archivedAt: null },
  };
}

// fallow-ignore-next-line unused-type
export interface BulkImportItem {
  sku: string;
  name: string;
  price: string | null;
}

// fallow-ignore-next-line unused-type
export interface BulkImportResult {
  changeSetId: string;
  imported: string[];
  skipped: Array<{ sku: string; reason: string }>;
}

/**
 * Bulk import multiple products into the active change set as drafts.
 */
export function bulkImportDrafts(
  workspaceId: string,
  workspacePath: string,
  items: BulkImportItem[],
): BulkImportResult {
  const ws = findWorkspace();
  if (!ws) {
    throw new Error('Workspace not found.');
  }

  // Ensure we have an active change set
  let activeCs = findActiveChangeSet(workspaceId);
  if (!activeCs) {
    const baseCommit = ws.baselineCommit ?? 'unknown';
    const timestamp = new Date().toISOString().slice(0, 10);
    activeCs = createChangeSet({
      workspaceId,
      title: `Bulk Import - ${timestamp}`,
      baseCommit,
    });
  }

  const imported: string[] = [];
  const skipped: Array<{ sku: string; reason: string }> = [];
  const seenSkusInBatch = new Set<string>();

  for (const item of items) {
    const sku = item.sku.trim();
    const name = item.name.trim();

    // Validate SKU format
    if (!sku) {
      skipped.push({ sku: '(empty)', reason: 'SKU is required' });
      continue;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(sku)) {
      skipped.push({ sku, reason: 'SKU must be alphanumeric with hyphens or underscores only' });
      continue;
    }
    if (!name) {
      skipped.push({ sku, reason: 'Product name is required' });
      continue;
    }
    if (seenSkusInBatch.has(sku)) {
      skipped.push({ sku, reason: 'Duplicate SKU in import list' });
      continue;
    }
    seenSkusInBatch.add(sku);

    // Verify SKU uniqueness in existing catalog
    const approved = readProductFile(workspacePath, sku);
    if (approved) {
      skipped.push({ sku, reason: 'SKU already exists in the catalog' });
      continue;
    }

    try {
      autosaveDraft(
        workspaceId,
        workspacePath,
        sku,
        {
          core: {
            name,
            price: item.price ? String(item.price) : null,
          } as any,
        },
        'create',
      );
      imported.push(sku);
    } catch (err) {
      skipped.push({ sku, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    changeSetId: activeCs.id,
    imported,
    skipped,
  };
}

// fallow-ignore-next-line unused-type
export interface CatalogHealthReport {
  totalProducts: number;
  healthyProducts: number;
  unhealthyProducts: number;
  totalErrors: number;
  totalWarnings: number;
  issues: Array<{
    sku: string;
    title: string;
    severity: string;
    code: string;
    message: string;
    fieldPath: string | null;
  }>;
}

/**
 * Validate every product in the catalog against the active workspace.
 */
/**
 * Validate every product in the catalog against the active workspace.
 */
export function validateCatalogHealth(workspaceId: string, workspacePath: string): CatalogHealthReport {
  // 1. Clear all previous catalog-scoped validation results
  clearValidationResultsForScope('catalog');

  // 2. Fetch all products in the index
  const { products } = listProducts();
  const allSkus = products.map(p => p.sku);

  let healthyProducts = 0;
  let unhealthyProducts = 0;
  let totalErrors = 0;
  let totalWarnings = 0;
  let totalActiveProducts = 0;
  const issues: CatalogHealthReport['issues'] = [];

  const db = getDb();
  const rulesConfig = getHealthRulesRecord(workspacePath);

  for (const indexedProd of products) {
    if (indexedProd.status !== 'active') {
      db.run('UPDATE product_index SET has_warnings = 0 WHERE sku = ?', [indexedProd.sku]);
      continue;
    }

    totalActiveProducts++;
    const product = readProductFile(workspacePath, indexedProd.sku);
    if (!product) {
      // If product file is missing, it's a blocker!
      unhealthyProducts++;
      totalErrors++;
      db.run('UPDATE product_index SET has_warnings = 1 WHERE sku = ?', [indexedProd.sku]);
      continue;
    }

    const context = {
      workspaceId,
      scopeType: 'catalog' as const,
      scopeId: indexedProd.sku,
      allSkus,
      rulesConfig,
    };

    // run validation (check registry, skip drift since drift is remote & slow)
    const results = validateProduct(product, context, { checkRegistry: true, checkDrift: false });
    const blockers = results.filter(r => r.severity === 'blocker');
    const warnings = results.filter(r => r.severity === 'warning');

    const hasIssue = blockers.length > 0 || warnings.length > 0;
    
    // Update the index's has_warnings column
    db.run('UPDATE product_index SET has_warnings = ? WHERE sku = ?', [hasIssue ? 1 : 0, indexedProd.sku]);

    if (hasIssue) {
      unhealthyProducts++;
      totalErrors += blockers.length;
      totalWarnings += warnings.length;
      issues.push(...results.map(r => ({
        sku: indexedProd.sku,
        title: product.core.name || indexedProd.title,
        severity: r.severity,
        code: r.code,
        message: r.message,
        fieldPath: r.fieldPath,
      })));
    } else {
      healthyProducts++;
    }
  }

  return {
    totalProducts: totalActiveProducts,
    healthyProducts,
    unhealthyProducts,
    totalErrors,
    totalWarnings,
    issues,
  };
}

/**
 * Retrieve the previously stored catalog health report.
 */
export function getCatalogHealthReport(): CatalogHealthReport {
  const { products } = listProducts();
  const activeProducts = products.filter(p => p.status === 'active');
  const db = getDb();
  const rows = db.query(
    "SELECT * FROM validation_results WHERE scope_type = 'catalog' ORDER BY created_at ASC"
  ).all() as any[];

  // Map product title from index for issues
  const skuToTitle = new Map<string, string>();
  for (const p of activeProducts) {
    skuToTitle.set(p.sku, p.title);
  }

  // Filter issues to only include active products
  const activeSkus = new Set(activeProducts.map(p => p.sku));
  const issues = rows
    .filter(row => activeSkus.has(String(row.scope_id)))
    .map(row => ({
      sku: String(row.scope_id),
      title: skuToTitle.get(String(row.scope_id)) || 'Unknown Product',
      severity: String(row.severity),
      code: String(row.code),
      message: String(row.message),
      fieldPath: row.field_path ? String(row.field_path) : null,
    }));

  const totalErrors = issues.filter(i => i.severity === 'blocker').length;
  const totalWarnings = issues.filter(i => i.severity === 'warning').length;
  const unhealthySkus = new Set(issues.map(i => i.sku));

  return {
    totalProducts: activeProducts.length,
    healthyProducts: activeProducts.length - unhealthySkus.size,
    unhealthyProducts: unhealthySkus.size,
    totalErrors,
    totalWarnings,
    issues,
  };
}

// fallow-ignore-next-line unused-type
export interface HealthRuleConfig {
  code: string;
  name: string;
  description: string;
  defaultSeverity: 'blocker' | 'warning' | 'info';
  severity: 'blocker' | 'warning' | 'info' | 'disabled';
}

// fallow-ignore-next-line unused-type
export interface HealthConfig {
  schemaVersion: number;
  rules: HealthRuleConfig[];
}

const DEFAULT_HEALTH_RULES: HealthRuleConfig[] = [
  {
    code: 'MISSING_NAME',
    name: 'Product Name Populate check',
    description: 'Ensure product name is populated (not empty).',
    defaultSeverity: 'blocker',
    severity: 'blocker',
  },
  {
    code: 'INVALID_PRICE',
    name: 'Valid Price Number Format',
    description: 'Ensure price format is a valid non-negative float.',
    defaultSeverity: 'blocker',
    severity: 'blocker',
  },
  {
    code: 'INVALID_SALE_PRICE',
    name: 'Valid Sale Price Number Format',
    description: 'Ensure sale price format is a valid non-negative float.',
    defaultSeverity: 'blocker',
    severity: 'blocker',
  },
  {
    code: 'MISSING_PRICE',
    name: 'Price Populate check',
    description: 'Ensure product price is set (not null/empty).',
    defaultSeverity: 'warning',
    severity: 'warning',
  },
  {
    code: 'MISSING_DESCRIPTION',
    name: 'Description check',
    description: 'Ensure product description is populated for SEO.',
    defaultSeverity: 'warning',
    severity: 'warning',
  },
  {
    code: 'MISSING_PRIMARY_IMAGE',
    name: 'Primary Image check',
    description: 'Ensure product has a primary image reference.',
    defaultSeverity: 'warning',
    severity: 'warning',
  },
  {
    code: 'SUSPICIOUS_MEDIA_REF',
    name: 'Suspicious Media reference format',
    description: 'Ensure primary media path looks like a valid URL or path.',
    defaultSeverity: 'warning',
    severity: 'warning',
  },
  {
    code: 'UNKNOWN_PRESERVED_FIELDS',
    name: 'Unknown Preserved fields check',
    description: 'Warn if the product has unknown elements preserved.',
    defaultSeverity: 'warning',
    severity: 'warning',
  },
  {
    code: 'ADVANCED_BLOCKS_PRESERVED',
    name: 'Advanced Blocks check',
    description: 'Warn if product has advanced blocks (options, subproducts) preserved.',
    defaultSeverity: 'warning',
    severity: 'warning',
  },
];

import { readStoreConfig, writeStoreConfig } from '../../git/workspace-files';

export function getHealthConfig(workspacePath: string): HealthConfig {
  const config = readStoreConfig<HealthConfig>(workspacePath, 'health-config.json');
  if (config && config.rules && Array.isArray(config.rules)) {
    // Fill in any missing default rules (migration safety)
    const ruleCodes = new Set(config.rules.map(r => r.code));
    const mergedRules = [...config.rules];
    for (const defRule of DEFAULT_HEALTH_RULES) {
      if (!ruleCodes.has(defRule.code)) {
        mergedRules.push(defRule);
      }
    }
    return {
      schemaVersion: config.schemaVersion ?? 1,
      rules: mergedRules,
    };
  }
  return {
    schemaVersion: 1,
    rules: DEFAULT_HEALTH_RULES,
  };
}

export function saveHealthConfig(workspacePath: string, rules: HealthRuleConfig[]): { success: boolean } {
  writeStoreConfig(workspacePath, 'health-config.json', {
    schemaVersion: 1,
    rules,
  });
  return { success: true };
}

function getHealthRulesRecord(workspacePath: string): Record<string, 'blocker' | 'warning' | 'info' | 'disabled'> {
  const config = getHealthConfig(workspacePath);
  const record: Record<string, 'blocker' | 'warning' | 'info' | 'disabled'> = {};
  for (const rule of config.rules) {
    record[rule.code] = rule.severity;
  }
  return record;
}


