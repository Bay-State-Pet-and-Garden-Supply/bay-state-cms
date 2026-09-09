import { getDb } from '../db/connection';
import { findBatchById } from '../db/repositories/onboarding-batch-repo';
import { listItemsByBatch } from '../db/repositories/onboarding-item-repo';
import { listAllBrandSites } from '../db/repositories/brand-site-repo';
import { matchExistingBrand } from '../shared/brand-matcher';

/**
 * Controlled-release partition + missing-brand grouping (replaces the
 * deleted batch preflight analyzer).
 *
 * Release rule (behavior-preserving): an item is ready iff it has a
 * non-empty trimmed `brandHint`. There is deliberately NO
 * `distributor_record` exemption here — domain/routing coverage stays
 * advisory and never gates release.
 */

export function toTitleCase(str: string): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .split(/(\s+|[-'/&])/)
    .map((part) => {
      if (!part || /^\s+$/.test(part) || /^[-'/&]$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join('');
}

/**
 * Extract candidate brand phrase from product name when brand is not yet assigned.
 * ONLY matches against existing known brands in the system — never makes
 * speculative brand inferences for unknown brands.
 */
export function extractCandidateBrand(name: string, knownBrands: string[]): string | null {
  if (!name) return null;
  const cleaned = name.trim();
  return matchExistingBrand(cleaned, knownBrands);
}

export interface MissingBrandGroup {
  key: string;
  suggestedBrand: string | null;
  itemCount: number;
  itemIds: string[];
  sampleProductNames: string[];
}

/** Canonical known-brand spellings (Brand Hub brand_sites + catalog fallback). */
export function listKnownBrandNames(): string[] {
  const known = new Map<string, string>();
  for (const site of listAllBrandSites()) {
    const raw = site.brandName.trim();
    if (raw && !known.has(raw.toLowerCase())) {
      known.set(raw.toLowerCase(), raw === raw.toUpperCase() && raw.length > 3 ? toTitleCase(raw) : raw);
    }
  }
  try {
    const db = getDb();
    const rows = db
      .query(
        `SELECT DISTINCT json_extract(custom_fields, '$.ProductField16') AS brandName
         FROM product_index WHERE brandName IS NOT NULL AND brandName != '' LIMIT 500`,
      )
      .all() as { brandName?: string }[];
    for (const r of rows) {
      if (r?.brandName) {
        const raw = r.brandName.trim();
        if (raw && !known.has(raw.toLowerCase())) {
          known.set(raw.toLowerCase(), raw === raw.toUpperCase() && raw.length > 3 ? toTitleCase(raw) : raw);
        }
      }
    }
  } catch {
    // best-effort catalog fallback
  }
  return Array.from(known.values()).sort((a, b) => a.localeCompare(b));
}

/** Partition a batch's items into ready/held by trimmed brandHint presence. */
export function partitionBatchByBrand(batchId: string): { readyItemIds: string[]; heldItemIds: string[] } {
  const readyItemIds: string[] = [];
  const heldItemIds: string[] = [];
  for (const item of listItemsByBatch(batchId)) {
    if (item.brandHint?.trim()) readyItemIds.push(item.id);
    else heldItemIds.push(item.id);
  }
  return { readyItemIds, heldItemIds };
}

/** Grouped missing-brand clusters for the frozen attention panel. */
export function buildMissingBrandGroups(batchId: string): MissingBrandGroup[] {
  const batch = findBatchById(batchId);
  if (!batch) throw new Error(`Batch not found: ${batchId}`);
  const knownBrands = listKnownBrandNames();
  const byKey = new Map<string, { suggestedBrand: string | null; itemIds: string[]; sampleProductNames: string[] }>();
  for (const item of listItemsByBatch(batchId)) {
    if (item.brandHint?.trim()) continue;
    const suggested = extractCandidateBrand(item.name, knownBrands);
    let key: string;
    if (suggested) {
      key = `suggested:${suggested.toLowerCase()}`;
    } else {
      // Group unknown items by their leading token so items sharing the same
      // brand prefix (e.g. "COOP & RANGE ...") cluster together without
      // falsely implying or pre-populating that leading token as the brand.
      const words = item.name.trim().split(/\s+/).filter(Boolean);
      const firstClean = words[0]?.replace(/[^A-Za-z0-9'&]/g, '').toLowerCase();
      key = firstClean ? `unassigned:${firstClean}` : 'unassigned:other';
    }
    const existing = byKey.get(key) ?? { suggestedBrand: suggested, itemIds: [], sampleProductNames: [] };
    existing.itemIds.push(item.id);
    if (existing.sampleProductNames.length < 10) existing.sampleProductNames.push(item.name);
    byKey.set(key, existing);
  }
  return Array.from(byKey.entries())
    .map(([key, data]) => ({ key, suggestedBrand: data.suggestedBrand, itemCount: data.itemIds.length, itemIds: data.itemIds, sampleProductNames: data.sampleProductNames }))
    .sort((a, b) => b.itemCount - a.itemCount);
}
