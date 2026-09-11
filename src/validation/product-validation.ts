import type { Product } from '../shared/types';
import type { ValidationResultRow } from '../db/repositories/validation-repo';
import { addValidationResult, hasBlockers } from '../db/repositories/validation-repo';
import { hasOpenDriftForSku } from '../db/repositories/drift-repo';
import { listRegistry } from '../db/repositories/field-registry-repo';


export interface ValidationContext {
  workspaceId: string;
  scopeType: 'product' | 'change_set' | 'catalog';
  scopeId: string;
  allSkus: string[];
  rulesConfig?: Record<string, 'blocker' | 'warning' | 'info' | 'disabled'>;
}

export interface ValidationOptions {
  /** Check for unresolved drift placeholders */
  checkDrift?: boolean;
  /** Check malformed registry */
  checkRegistry?: boolean;
  /** Check XML generation viability */
  checkXmlGeneration?: boolean;
}

/**
 * Resolve a rule's effective severity under optional store configuration.
 * Exported for preparation-gap derivation (ticket #124): gaps open only
 * on BLOCKING requirements, never on warnings — additive export, existing
 * callers unchanged.
 */
export function getRuleSeverity(
  code: string,
  defaultSeverity: 'blocker' | 'warning' | 'info',
  context: ValidationContext,
): 'blocker' | 'warning' | 'info' | 'disabled' {
  if (context.rulesConfig && code in context.rulesConfig) {
    return context.rulesConfig[code];
  }
  return defaultSeverity;
}

/**
 * Run all validation rules for a single product draft.
 * Returns the list of validation results.
 */
export function validateProduct(
  product: Product,
  context: ValidationContext,
  options?: ValidationOptions,
): ValidationResultRow[] {
  const results: ValidationResultRow[] = [];
  const scopeType = context.scopeType;
  const scopeId = context.scopeId;

  // Clear previous results for this product within the scope
  // (caller should clear per scope)

  // 1. Missing SKU (blocker)
  if (!product.sku || product.sku.trim() === '') {
    results.push(addValidationResult({
      scopeType, scopeId,
      severity: 'blocker',
      code: 'MISSING_SKU',
      message: 'Product SKU is required and cannot be empty.',
      fieldPath: 'sku',
    }));
  }

  // 2. Duplicate SKU (blocker)
  if (product.sku && context.allSkus.filter(s => s === product.sku).length > 1) {
    results.push(addValidationResult({
      scopeType, scopeId,
      severity: 'blocker',
      code: 'DUPLICATE_SKU',
      message: `SKU "${product.sku}" appears more than once in this change set.`,
      fieldPath: 'sku',
    }));
  }

  // 3. Changed synced SKU (blocker)
  // If a product already has been pushed/synced, SKU must not change
  if (product.shopsite.lastSyncedAt && product.metadata.createdAt !== product.metadata.updatedAt) {
    // We detect SKU change by checking if there's a base product with different SKU
    // Handled at change-set level during approval via baseJson comparison
  }

  // 4. Invalid price (blocker)
  const invalidPriceSev = getRuleSeverity('INVALID_PRICE', 'blocker', context);
  if (invalidPriceSev !== 'disabled' && product.core.price != null && product.core.price !== '') {
    const priceNum = parseFloat(product.core.price);
    if (isNaN(priceNum) || priceNum < 0) {
      results.push(addValidationResult({
        scopeType, scopeId,
        severity: invalidPriceSev,
        code: 'INVALID_PRICE',
        message: `Price "${product.core.price}" is not a valid non-negative number.`,
        fieldPath: 'core.price',
      }));
    }
  }
  const invalidSalePriceSev = getRuleSeverity('INVALID_SALE_PRICE', 'blocker', context);
  if (invalidSalePriceSev !== 'disabled' && product.core.salePrice != null && product.core.salePrice !== '') {
    const saleNum = parseFloat(product.core.salePrice);
    if (isNaN(saleNum) || saleNum < 0) {
      results.push(addValidationResult({
        scopeType, scopeId,
        severity: invalidSalePriceSev,
        code: 'INVALID_SALE_PRICE',
        message: `Sale price "${product.core.salePrice}" is not a valid non-negative number.`,
        fieldPath: 'core.salePrice',
      }));
    }
  }

  // 5. Missing name (blocker)
  const missingNameSev = getRuleSeverity('MISSING_NAME', 'blocker', context);
  if (missingNameSev !== 'disabled' && (!product.core.name || product.core.name.trim() === '')) {
    results.push(addValidationResult({
      scopeType, scopeId,
      severity: missingNameSev,
      code: 'MISSING_NAME',
      message: 'Product name is required.',
      fieldPath: 'core.name',
    }));
  }

  // 6. Unresolved drift (blocker if checkDrift)
  const unresolvedDriftSev = getRuleSeverity('UNRESOLVED_DRIFT', 'blocker', context);
  if (unresolvedDriftSev !== 'disabled' && options?.checkDrift && product.sku) {
    try {
      if (hasOpenDriftForSku(context.workspaceId, product.sku)) {
        results.push(addValidationResult({
          scopeType, scopeId,
          severity: unresolvedDriftSev,
          code: 'UNRESOLVED_DRIFT',
          message: `Product "${product.sku}" has unresolved remote drift. Resolve drift before pushing.`,
          fieldPath: 'sku',
        }));
      }
    } catch {
      // Drift table may not exist or workspace not initialized yet
    }
  }

  // 7. Malformed registry placeholder (blocker if checkRegistry)
  if (options?.checkRegistry && context.workspaceId) {
    try {
      const registry = listRegistry(context.workspaceId);
      for (const entry of registry) {
        if (entry.kind === 'core') continue;
        const val = product.customFields[entry.xmlField];
        if (entry.required) {
          if (val === undefined || val === null || val.trim() === '') {
            results.push(addValidationResult({
              scopeType, scopeId,
              severity: 'blocker',
              code: 'MISSING_REQUIRED_FIELD',
              message: `Required custom field "${entry.label}" (${entry.xmlField}) is missing or empty.`,
              fieldPath: `customFields.${entry.xmlField}`,
            }));
          }
        }
        if (val !== undefined && val !== null && val.trim() !== '') {
          if (entry.dataType === 'number') {
            const num = parseFloat(val);
            if (isNaN(num)) {
              results.push(addValidationResult({
                scopeType, scopeId,
                severity: 'blocker',
                code: 'INVALID_NUMBER_FORMAT',
                message: `Custom field "${entry.label}" (${entry.xmlField}) value "${val}" is not a valid number.`,
                fieldPath: `customFields.${entry.xmlField}`,
              }));
            }
          } else if (entry.dataType === 'boolean') {
            const norm = val.toLowerCase().trim();
            if (norm !== 'true' && norm !== 'false' && norm !== '1' && norm !== '0' && norm !== 'yes' && norm !== 'no' && norm !== 'checked' && norm !== 'unchecked') {
              results.push(addValidationResult({
                scopeType, scopeId,
                severity: 'warning',
                code: 'INVALID_BOOLEAN_FORMAT',
                message: `Custom field "${entry.label}" (${entry.xmlField}) value "${val}" is not a recognized boolean format. Use yes/no, true/false, or 1/0.`,
                fieldPath: `customFields.${entry.xmlField}`,
              }));
            }
          }
        }
      }
    } catch (err) {
      // Registry table may not exist or workspace not initialized
    }
  }

  // 8. XML generation failure placeholder (blocker if checkXmlGeneration)
  if (options?.checkXmlGeneration) {
    // Placeholder: will attempt XML generation and catch errors
  }

  // Warnings:

  // 12. Missing description (warning)
  const missingDescriptionSev = getRuleSeverity('MISSING_DESCRIPTION', 'warning', context);
  if (missingDescriptionSev !== 'disabled' && (!product.core.description || product.core.description.trim() === '')) {
    results.push(addValidationResult({
      scopeType, scopeId,
      severity: missingDescriptionSev,
      code: 'MISSING_DESCRIPTION',
      message: 'Product description is empty. Setting a description is recommended for SEO.',
      fieldPath: 'core.description',
    }));
  }

  // 13. Missing price (warning)
  const missingPriceSev = getRuleSeverity('MISSING_PRICE', 'warning', context);
  if (missingPriceSev !== 'disabled' && (product.core.price == null || product.core.price.trim() === '')) {
    results.push(addValidationResult({
      scopeType, scopeId,
      severity: missingPriceSev,
      code: 'MISSING_PRICE',
      message: 'Product price is not set.',
      fieldPath: 'core.price',
    }));
  }

  // 14. Missing primary image (warning)
  const missingPrimaryImageSev = getRuleSeverity('MISSING_PRIMARY_IMAGE', 'warning', context);
  if (missingPrimaryImageSev !== 'disabled' && (!product.core.media.primary || product.core.media.primary.trim() === '')) {
    results.push(addValidationResult({
      scopeType, scopeId,
      severity: missingPrimaryImageSev,
      code: 'MISSING_PRIMARY_IMAGE',
      message: 'Product has no primary image.',
      fieldPath: 'core.media.primary',
    }));
  }

  // 9. Missing/broken media reference (warning)
  const suspiciousMediaSev = getRuleSeverity('SUSPICIOUS_MEDIA_REF', 'warning', context);
  if (suspiciousMediaSev !== 'disabled' && product.core.media.primary && !product.core.media.primary.startsWith('http') && !product.core.media.primary.startsWith('/') && !product.core.media.primary.includes('.')) {
    results.push(addValidationResult({
      scopeType, scopeId,
      severity: suspiciousMediaSev,
      code: 'SUSPICIOUS_MEDIA_REF',
      message: `Primary media "${product.core.media.primary}" does not look like a valid URL or path.`,
      fieldPath: 'core.media.primary',
    }));
  }

  // 10. Unknown preserved fields (warning)
  const unknownPreservedSev = getRuleSeverity('UNKNOWN_PRESERVED_FIELDS', 'warning', context);
  if (unknownPreservedSev !== 'disabled') {
    const unknownCount = Object.keys(product.shopsite.preserved.unknownElements).length;
    if (unknownCount > 0) {
      results.push(addValidationResult({
        scopeType, scopeId,
        severity: unknownPreservedSev,
        code: 'UNKNOWN_PRESERVED_FIELDS',
        message: `Product has ${unknownCount} unknown preserved field(s) that will be round-tripped but may need review.`,
        fieldPath: 'shopsite.preserved.unknownElements',
      }));
    }
  }

  // 11. Advanced blocks preserved (warning)
  const advancedBlocksSev = getRuleSeverity('ADVANCED_BLOCKS_PRESERVED', 'warning', context);
  if (advancedBlocksSev !== 'disabled' && product.shopsite.preserved.advancedBlocks && Object.keys(product.shopsite.preserved.advancedBlocks).length > 0) {
    results.push(addValidationResult({
      scopeType, scopeId,
      severity: advancedBlocksSev,
      code: 'ADVANCED_BLOCKS_PRESERVED',
      message: 'Product contains advanced blocks (e.g., subproducts, options) that are preserved but not editable in v1.',
      fieldPath: 'shopsite.preserved.advancedBlocks',
    }));
  }

  return results;
}

/**
 * Check if a scope has blockers.
 */
function scopeHasBlockers(scopeType: string, scopeId: string): boolean {
  return hasBlockers(scopeType, scopeId);
}
