import { clearValidationResults, listValidationResults, addValidationResult } from '../db/repositories/validation-repo';
import { resolveBaseFileName, findDuplicateFileNames } from '../shopsite/file-name';
import { findChangeSetById, listChangeSetItems, setItemValidationStatus } from '../db/repositories/change-set-repo';
import { validateProduct, type ValidationContext, type ValidationOptions } from './product-validation';
import { readStoreConfig } from '../git/workspace-files';
import { findWorkspace } from '../db/repositories/workspace-repo';
import { getDb } from '../db/connection';
import type { Product } from '../shared/types';

export interface ChangeSetValidationResult {
  total: number;
  blockers: number;
  warnings: number;
  infos: number;
  items: Array<{
    sku: string;
    operation: string;
    results: Array<{
      severity: string;
      code: string;
      message: string;
      fieldPath: string | null;
    }>;
  }>;
  canApprove: boolean;
}

/**
 * Validate all items in a change set.
 */
export function validateChangeSet(changeSetId: string, options?: ValidationOptions): ChangeSetValidationResult {
  const db = getDb();
  return db.transaction(() => {
    const changeSet = findChangeSetById(changeSetId);
    const items = listChangeSetItems(changeSetId);
  const allSkus = items.map(i => JSON.parse(i.draftJson)?.sku || i.sku).filter(Boolean);
  const effectiveOptions: ValidationOptions = { checkDrift: true, ...options };

  // Load health config to respect manager settings
  const ws = findWorkspace();
  const rulesConfig: Record<string, any> = {};
  if (ws?.workspacePath) {
    const config = readStoreConfig<{ rules: Array<{ code: string; severity: any }> }>(ws.workspacePath, 'health-config.json');
    if (config?.rules) {
      for (const r of config.rules) {
        rulesConfig[r.code] = r.severity;
      }
    }
  }

  const context: ValidationContext = {
    workspaceId: changeSet?.workspaceId ?? '',
    scopeType: 'change_set',
    scopeId: changeSetId,
    allSkus,
    rulesConfig,
  };

  // Clear previous validation results for this change set
  clearValidationResults('change_set', changeSetId);

  let totalBlockers = 0;
  let totalWarnings = 0;
  let totalInfos = 0;
  const itemResults: ChangeSetValidationResult['items'] = [];

  for (const item of items) {
    let product: Product;
    try {
      product = JSON.parse(item.draftJson) as Product;
    } catch {
      setItemValidationStatus(changeSetId, item.sku, 'blocked');
      itemResults.push({
        sku: item.sku,
        operation: item.operation,
        results: [{
          severity: 'blocker',
          code: 'PARSE_ERROR',
          message: 'Could not parse draft JSON for this product.',
          fieldPath: null,
        }],
      });
      totalBlockers++;
      continue;
    }

    // Check SKU change from base
    const baseSku = item.baseJson ? (JSON.parse(item.baseJson) as Product)?.sku : null;
    if (baseSku && baseSku !== product.sku) {
      clearValidationResults('change_set', changeSetId);
      // SKU change is a blocker - we'll just call addValidationResult from within validateProduct
    }

    const results = validateProduct(product, context, effectiveOptions);
    const blockers = results.filter(r => r.severity === 'blocker').length;
    const warnings = results.filter(r => r.severity === 'warning').length;
    const infos = results.filter(r => r.severity === 'info').length;

    totalBlockers += blockers;
    totalWarnings += warnings;
    totalInfos += infos;

    setItemValidationStatus(changeSetId, item.sku, blockers > 0 ? 'blocked' : (warnings > 0 ? 'warning' : 'valid'));

    itemResults.push({
      sku: item.sku,
      operation: item.operation,
      results: results.map(r => ({
        severity: r.severity,
        code: r.code,
        message: r.message,
        fieldPath: r.fieldPath,
      })),
    });
  }

  // SKU change detection at change set level
  // Check if any item changed its SKU from base (synced SKU mutation check)
  for (const item of items) {
    if (item.baseJson) {
      try {
        const baseProduct = JSON.parse(item.baseJson) as Product;
        const draftProduct = JSON.parse(item.draftJson) as Product;
        if (baseProduct.sku !== draftProduct.sku && baseProduct.shopsite?.lastSyncedAt) {
          // SKU changed on a synced product - add blocker directly
              addValidationResult({
            scopeType: 'change_set',
            scopeId: changeSetId,
            severity: 'blocker',
            code: 'SYNCED_SKU_CHANGED',
            message: `Cannot change SKU of synced product from "${baseProduct.sku}" to "${draftProduct.sku}". Synced SKUs are immutable.`,
            fieldPath: 'sku',
          });
          totalBlockers++;
        }
      } catch { /* skip */ }
    }
  }

  // Issue #107: duplicate more-information page file names fail closed.
  // Sibling drafts whose effective <FileName> values collide (identical or
  // slug-colliding names, case-insensitive) would cross-link detail pages in
  // the live store. Unlike DUPLICATE_SKU (per-item via context.allSkus),
  // this needs the whole change set, so it lives here at the change-set level.
  try {
    const nameEntries: Array<{ key: string; fileName: string }> = [];
    for (const item of items) {
      try {
        const draft = JSON.parse(item.draftJson) as Product;
        if (draft?.sku) nameEntries.push({ key: draft.sku, fileName: resolveBaseFileName(draft) });
      } catch { /* unparseable drafts already recorded as PARSE_ERROR above */ }
    }
    for (const group of findDuplicateFileNames(nameEntries)) {
      addValidationResult({
        scopeType: 'change_set',
        scopeId: changeSetId,
        severity: 'blocker',
        code: 'DUPLICATE_FILENAME',
        message: `More-information page file name "${group.fileName}" is shared by ${group.keys.length} products (${group.keys.join(', ')}). Give each product a distinct file name before approval.`,
        fieldPath: null,
      });
      // Mirror a pointer onto each member item: per-item surfaces render
      // itemResults[].results, which would otherwise stay green while the
      // change set cannot approve. Member items are marked blocked.
      for (const sku of group.keys) {
        const member = itemResults.find(i => i.sku === sku);
        if (!member) continue;
        const row = addValidationResult({
          scopeType: 'change_set',
          scopeId: changeSetId,
          severity: 'blocker',
          code: 'DUPLICATE_FILENAME',
          message: `More-information page file name "${group.fileName}" is shared with another product in this change set. Give each product a distinct file name before approval.`,
          fieldPath: null,
        });
        member.results.push({
          severity: row.severity,
          code: row.code,
          message: row.message,
          fieldPath: row.fieldPath,
        });
        setItemValidationStatus(changeSetId, sku, 'blocked');
      }
    }
  } catch { /* filename validation never blocks validation itself */ }

  // Re-fetch results after our additions
  const allResults = listValidationResults('change_set', changeSetId);
  totalBlockers = allResults.filter(r => r.severity === 'blocker').length;
  totalWarnings = allResults.filter(r => r.severity === 'warning').length;
  totalInfos = allResults.filter(r => r.severity === 'info').length;

  return {
    total: items.length,
    blockers: totalBlockers,
    warnings: totalWarnings,
    infos: totalInfos,
    items: itemResults,
    canApprove: totalBlockers === 0,
  };
  })();
}
