import type { DriftRow } from '../db/repositories/drift-repo';
import type { Product } from '../shared/types';
import type { FieldHunk } from './catalog-comparison';

export interface ParsedDriftDiff {
  hunks: FieldHunk[];
  baselineCommit: string | null;
  baselineSource: 'head' | 'working-tree';
  baselineDirty: boolean;
  projectionVersion: string;
  hasLocalProduct: boolean;
  context: {
    projectionVersion: string;
    builtInPolicyVersion: string;
    fieldCatalogVersion: string;
    pageImportHash: string | null;
  } | null;
  raw: Record<string, unknown>;
}

export function parseDriftDiff(drift: DriftRow): ParsedDriftDiff {
  let raw: Record<string, unknown>;
  try {
    raw = drift.diffJson ? (JSON.parse(drift.diffJson) as Record<string, unknown>) : {};
  } catch {
    raw = {};
  }
  const hunks = Array.isArray((raw as { hunks?: unknown }).hunks)
    ? ((raw as { hunks: FieldHunk[] }).hunks.filter(
        (h) => h && typeof h.field === 'string',
      ) as FieldHunk[])
    : [];
  const ctx = (raw as { context?: ParsedDriftDiff['context'] }).context ?? null;
  return {
    hunks,
    baselineCommit: typeof raw.baselineCommit === 'string' ? (raw.baselineCommit as string) : null,
    baselineSource: raw.baselineSource === 'working-tree' ? 'working-tree' : 'head',
    baselineDirty: raw.baselineDirty === true,
    projectionVersion:
      typeof raw.projectionVersion === 'string' ? (raw.projectionVersion as string) : 'catalog-comparison-v1',
    hasLocalProduct: raw.hasLocalProduct !== false && drift.localJson != null,
    context: ctx,
    raw,
  };
}

export type HunkHeldReason = 'new_product' | 'in_reconcile' | 'unavailable_assignment';

export interface HeldReasonOptions {
  /**
   * Reconciled field set for an `in_reconcile` row, derived from the frozen
   * linked change-set draft (base vs draft diff). When undefined/null the
   * row is treated as fully reconciled (fail closed: every hunk held).
   * Callers with change-set context pass the computed set so unrelated
   * outstanding fields stay resolvable while linked fields stay held.
   */
  reconciledFields?: Set<string> | null;
  /**
   * The specific hunk under review (baseline/remote values). Page
   * availability is decided per hunk from its stable-identity values:
   * `id:*` is verified, `name:*` is unverified. When omitted, any
   * name-based page hunk on the row holds the field (fail closed).
   */
  hunk?: { baselineValue: string | null; remoteValue: string | null } | null;
}

function isUnverifiedPageValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith('name:');
}

/**
 * Held-aside cases (#253 existing-product slice holds; #257 promotes the
 * held cases to first-class workflows):
 * - `new_product`: no local baseline — resolves via the explicit new-product
 *   import workflow, never per-hunk accept.
 * - `in_reconcile`: only hunks in the frozen reconciled set are held. When
 *   the set is unknown the whole row holds (fail closed); unrelated fields
 *   on the same product stay resolvable so selected-field reconciliation is
 *   never permanently blocked.
 * - `unavailable_assignment`: only page hunks whose remote value lacks a
 *   stable live-store identity (`name:*`) are held. Verified (`id:*`) page
 *   moves resolve like any other hunk; held hunks never silently overwrite
 *   local assignments (accept holds, explicit reject/reconcile stay open).
 */
export function heldReasonForHunk(
  drift: DriftRow,
  parsed: ParsedDriftDiff,
  field: string,
  options?: HeldReasonOptions,
): HunkHeldReason | null {
  if (drift.status === 'in_reconcile') {
    const set = options?.reconciledFields;
    if (set == null) return 'in_reconcile';
    return set.has(field) ? 'in_reconcile' : null;
  }
  if (!parsed.hasLocalProduct) return 'new_product';
  if (field === 'core.productOnPages') {
    const hunk = options?.hunk;
    if (hunk) {
      return isUnverifiedPageValue(hunk.remoteValue) ? 'unavailable_assignment' : null;
    }
    // No specific hunk supplied: hold when any page hunk carries an
    // unverified remote identity (fail closed).
    const anyUnverified = parsed.hunks.some(
      (h) => h.field === 'core.productOnPages' && isUnverifiedPageValue(h.remoteValue),
    );
    return anyUnverified ? 'unavailable_assignment' : null;
  }
  return null;
}

/** Filename-bearing comparison fields (collision protection applies). */
export function isFilenameField(field: string): boolean {
  return field === 'seo.fileName' || field === 'custom.FileName';
}

/**
 * Merge exactly one field from the remote product into a clone of the
 * baseline product, preserving every unrelated field and the existing
 * product identity (id, sku, metadata, source pointers).
 */
export function applySingleFieldHunk(baseline: Product, remote: Product, field: string): Product {
  const next = structuredClone(baseline) as Product;
  // Identity is never rewritten by a hunk accept.
  next.id = baseline.id;
  next.sku = baseline.sku;

  const setOrDeleteCustom = (tag: string, value: unknown): void => {
    if (value == null || String(value).trim() === '') {
      delete next.customFields[tag];
    } else {
      next.customFields[tag] = String(value);
    }
  };

  if (field === 'status') {
    next.status = remote.status;
    return next;
  }
  if (field === 'sku') {
    // SKU is identity: never rewritten (caller holds this case).
    return next;
  }
  if (field === 'core.name') {
    next.core.name = remote.core.name;
    return next;
  }
  if (field === 'core.price') {
    next.core.price = remote.core.price;
    return next;
  }
  if (field === 'core.salePrice') {
    next.core.salePrice = remote.core.salePrice;
    return next;
  }
  if (field === 'core.description') {
    next.core.description = remote.core.description;
    return next;
  }
  if (field === 'core.weight') {
    next.core.weight = remote.core.weight;
    return next;
  }
  if (field === 'core.taxable') {
    next.core.taxable = remote.core.taxable;
    return next;
  }
  if (field === 'core.availability') {
    next.core.availability = remote.core.availability;
    return next;
  }
  if (field === 'core.quantityOnHand') {
    next.core.inventory = {
      ...next.core.inventory,
      quantityOnHand: remote.core.inventory.quantityOnHand,
    };
    return next;
  }
  if (field === 'core.media.primary') {
    next.core.media = { ...next.core.media, primary: remote.core.media.primary };
    return next;
  }
  if (field === 'core.media.additional') {
    next.core.media = {
      ...next.core.media,
      additional: [...(remote.core.media.additional ?? [])],
    };
    return next;
  }
  if (field === 'seo.fileName') {
    next.core.seo = { ...next.core.seo, fileName: remote.core.seo.fileName };
    return next;
  }
  if (field === 'seo.searchKeywords') {
    next.core.seo = { ...next.core.seo, searchKeywords: remote.core.seo.searchKeywords };
    return next;
  }
  if (field.startsWith('custom.')) {
    const tag = field.slice('custom.'.length);
    const hasCustom = remote.customFields[tag] != null;
    const preservedVal = remote.shopsite?.preserved?.unknownElements?.[tag];
    if (hasCustom) {
      setOrDeleteCustom(tag, remote.customFields[tag]);
      // Mirror the surviving effective value: drop the stale preserved copy
      // so the effective projection (custom-first) matches remote exactly.
      if (next.shopsite?.preserved?.unknownElements?.[tag] !== undefined) {
        delete (next.shopsite.preserved.unknownElements as Record<string, unknown>)[tag];
      }
    } else if (preservedVal != null) {
      delete next.customFields[tag];
      next.shopsite = {
        ...next.shopsite,
        preserved: {
          ...next.shopsite.preserved,
          unknownElements: {
            ...next.shopsite.preserved.unknownElements,
            [tag]: preservedVal,
          },
        },
      };
    } else {
      delete next.customFields[tag];
      if (next.shopsite?.preserved?.unknownElements?.[tag] !== undefined) {
        delete (next.shopsite.preserved.unknownElements as Record<string, unknown>)[tag];
      }
    }
    return next;
  }
  if (field === 'core.productOnPages') {
    // Page hunks are held in this slice, but the merge stays total for the
    // follow-on slice: copy first-class assignments plus preserved blocks.
    next.core.productOnPages = [...(remote.core.productOnPages ?? [])];
    const remoteUnknown = remote.shopsite?.preserved?.unknownElements?.['ProductOnPages'];
    const remoteAdvanced =
      remote.shopsite?.preserved?.advancedBlocks?.['ProductOnPages'] ??
      remote.shopsite?.preserved?.advancedBlocks?.['productOnPages'];
    next.shopsite = {
      ...next.shopsite,
      preserved: {
        ...next.shopsite.preserved,
        unknownElements: { ...next.shopsite.preserved.unknownElements },
        advancedBlocks: { ...next.shopsite.preserved.advancedBlocks },
      },
    };
    if (remoteUnknown != null) {
      (next.shopsite.preserved.unknownElements as Record<string, unknown>)['ProductOnPages'] = remoteUnknown;
    } else {
      delete (next.shopsite.preserved.unknownElements as Record<string, unknown>)['ProductOnPages'];
    }
    if (remoteAdvanced != null) {
      next.shopsite.preserved.advancedBlocks['ProductOnPages'] = String(remoteAdvanced);
      delete next.shopsite.preserved.advancedBlocks['productOnPages'];
    } else {
      delete next.shopsite.preserved.advancedBlocks['ProductOnPages'];
      delete next.shopsite.preserved.advancedBlocks['productOnPages'];
    }
    return next;
  }
  if (field.startsWith('preserved.unknown:')) {
    const tag = field.slice('preserved.unknown:'.length);
    const val = remote.shopsite?.preserved?.unknownElements?.[tag];
    next.shopsite = {
      ...next.shopsite,
      preserved: {
        ...next.shopsite.preserved,
        unknownElements: { ...next.shopsite.preserved.unknownElements },
      },
    };
    if (val != null && String(val).trim() !== '') {
      (next.shopsite.preserved.unknownElements as Record<string, unknown>)[tag] = val;
    } else {
      delete (next.shopsite.preserved.unknownElements as Record<string, unknown>)[tag];
    }
    return next;
  }
  if (field.startsWith('preserved.block:')) {
    const tag = field.slice('preserved.block:'.length);
    const val = remote.shopsite?.preserved?.advancedBlocks?.[tag];
    next.shopsite = {
      ...next.shopsite,
      preserved: {
        ...next.shopsite.preserved,
        advancedBlocks: { ...next.shopsite.preserved.advancedBlocks },
      },
    };
    if (val != null && String(val).trim() !== '') {
      next.shopsite.preserved.advancedBlocks[tag] = String(val);
    } else {
      delete next.shopsite.preserved.advancedBlocks[tag];
    }
    return next;
  }
  // Unknown future field: fail closed at the caller (no silent copy).
  throw new Error(`Unsupported drift field "${field}" for single-hunk apply.`);
}

/** All comparison fields this slice can accept per hunk. */
export function isSupportedHunkField(field: string): boolean {
  if (field === 'sku') return false;
  if (field === 'status') return true;
  if (field.startsWith('core.') || field.startsWith('custom.') || field.startsWith('seo.')) return true;
  if (field.startsWith('preserved.')) return true;
  return false;
}
