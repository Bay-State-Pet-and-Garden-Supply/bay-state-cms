/**
 * Canonical catalog comparison projection (issue #252).
 *
 * Single versioned projection used by import (bootstrap) and drift checking.
 * The pinned approved Git HEAD is the baseline; remote ShopSite data is
 * diffed against it through this projection. All comparison semantics live
 * here: built-in DTD defaults, canonical controlled-value identity, stable
 * Category Page identity, and preservation of unmodeled data.
 *
 * The projection records enough configuration + page-identity context to
 * invalidate stale comparisons without manufacturing drift.
 */

import { hashCanonicalJson } from '../shared/stable-id';
import {
  SHOP_SITE_BUILT_IN_OUTPUT_POLICY_VERSION,
} from './built-in-output-policy';
import { SHOP_SITE_FIELD_CATALOG_VERSION } from './field-catalog';
import {
  comparisonKey,
  matchCanonicalValue,
  resolveAlias,
} from '../classification/controlled-value-identity';
import type { Product } from '../shared/types';

export const CATALOG_COMPARISON_PROJECTION_VERSION = 'catalog-comparison-v1';
export const CATALOG_COMPARISON_PROJECTION_META_KEY = 'catalog_comparison_projection_version';

/**
 * Restart-safe projection-version marker. Writes ONLY its own app_meta key
 * so it never fights the dedup-key migration owned by the idempotency slice
 * (#250): no read/write/delete of any key containing `dedup`, no drift-row
 * mutation, no backfill. Repeated and concurrent runs are deterministic
 * (INSERT OR IGNORE + read-back).
 */
export function ensureCatalogComparisonProjectionVersion(
  db: { query: (sql: string) => { get: (...params: unknown[]) => unknown }; run: (sql: string, params?: unknown[]) => void },
): string {
  try {
    db.run('INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, ?)', [
      CATALOG_COMPARISON_PROJECTION_META_KEY,
      CATALOG_COMPARISON_PROJECTION_VERSION,
    ]);
  } catch {
    // Minimal DBs without app_meta: caller treats missing marker as unversioned.
  }
  try {
    const row = db.query('SELECT value FROM app_meta WHERE key = ?').get(
      CATALOG_COMPARISON_PROJECTION_META_KEY,
    ) as { value: string } | undefined;
    return row?.value ?? CATALOG_COMPARISON_PROJECTION_VERSION;
  } catch {
    return CATALOG_COMPARISON_PROJECTION_VERSION;
  }
}

/** Controlled-value set for one field: canonical IDs + reviewed aliases. */
export interface ControlledValueConfig {
  allowedValues: string[];
  aliases?: Array<{ alias: string; mapsTo: string }>;
}

/** Maps a page display name to its stable live-store identity key, or null when missing. */
export type PageIdentityResolver = (pageName: string) => string | null;

export interface ComparisonContext {
  projectionVersion: string;
  builtInPolicyVersion: string;
  fieldCatalogVersion: string;
  pageImportHash: string | null;
}

export interface ComparisonProjection {
  version: string;
  sku: string;
  fields: Record<string, string | null>;
  pages: string[];
  preserved: Record<string, string>;
}

export interface FieldHunk {
  field: string;
  baselineValue: string | null;
  remoteValue: string | null;
}

export interface BuildComparisonOptions {
  controlledByField?: Record<string, ControlledValueConfig>;
  resolvePageIdentity?: PageIdentityResolver;
  pageImportHash?: string | null;
}

/** Fields compared by canonical controlled identity when no explicit config is supplied. */
const DEFAULT_CONTROLLED_FIELDS = new Set([
  'core.availability',
  'custom.ProductType',
]);

function normalizeTextStrict(value: unknown): string | null {
  if (value == null) return null;
  let s = String(value).normalize('NFC').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ');
  s = s.trim();
  return s === '' ? null : s;
}

function normalizeCollapsed(value: unknown): string | null {
  const t = normalizeTextStrict(value);
  if (t == null) return null;
  return t.replace(/\s+/g, ' ');
}

function normalizePrice(value: unknown): string | null {
  const t = normalizeTextStrict(value);
  if (t == null) return null;
  const trimmed = t.replace(/,/g, '');
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return String(n);
  }
  return t;
}

function normalizeQuantity(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  const t = normalizeTextStrict(value);
  if (t == null) return null;
  const n = Number(t);
  if (Number.isInteger(n)) return String(n);
  return t;
}

function normalizeImagePath(value: unknown): string | null {
  const t = normalizeTextStrict(value);
  if (t == null) return null;
  if (t.toLowerCase() === 'none') return null;
  return t.replace(/^\.\//, '');
}

function normalizeFileNameValue(value: unknown): string | null {
  const t = normalizeTextStrict(value);
  if (t == null) return null;
  return t.toLowerCase();
}

function normalizeAdvancedBlock(value: unknown): string | null {
  const t = normalizeTextStrict(value);
  if (t == null) return null;
  return t.replace(/\s+/g, ' ');
}

function resolveEffectiveCustom(product: Product, tag: string): string | null {
  const fromCustom = product.customFields?.[tag];
  if (fromCustom != null && String(fromCustom).trim() !== '') return String(fromCustom);
  const fromUnknown = product.shopsite?.preserved?.unknownElements?.[tag];
  if (fromUnknown != null && String(fromUnknown).trim() !== '') return String(fromUnknown);
  return null;
}

function resolveControlled(
  raw: string | null,
  fieldKey: string,
  controlledByField?: Record<string, ControlledValueConfig>,
): string | null {
  if (raw == null) return null;
  const config = controlledByField?.[fieldKey];
  if (config) {
    const direct = matchCanonicalValue(raw, config.allowedValues);
    if (direct != null) return direct;
    const viaAlias = resolveAlias(raw, config.aliases ?? [], config.allowedValues);
    if (viaAlias != null) return viaAlias;
    return `unresolved:${comparisonKey(raw)}`;
  }
  if (DEFAULT_CONTROLLED_FIELDS.has(fieldKey)) {
    return comparisonKey(raw);
  }
  return normalizeTextStrict(raw);
}

function resolvePageIdentities(
  product: Product,
  resolvePageIdentity?: PageIdentityResolver,
): string[] {
  const names = new Set<string>();
  const firstClass = product.core?.productOnPages ?? [];
  for (const n of firstClass) {
    const t = normalizeTextStrict(n);
    if (t) names.add(t);
  }
  const fromUnknown = product.shopsite?.preserved?.unknownElements?.['ProductOnPages'];
  if (fromUnknown) {
    for (const n of extractNames(String(fromUnknown))) names.add(n);
  }
  const fromAdvanced =
    product.shopsite?.preserved?.advancedBlocks?.['ProductOnPages'] ??
    product.shopsite?.preserved?.advancedBlocks?.['productOnPages'];
  if (fromAdvanced) {
    for (const n of extractNames(String(fromAdvanced))) names.add(n);
  }

  const identities = new Set<string>();
  for (const name of names) {
    const key = resolvePageIdentity?.(name) ?? null;
    if (key) {
      identities.add(`id:${key}`);
    } else {
      identities.add(`name:${name.toLowerCase()}`);
    }
  }
  return Array.from(identities).sort();
}

function extractNames(rawXml: string): string[] {
  const out: string[] = [];
  const tagRegex = /<(?:Name|PageName|PageLink)>([^<]*)<\/(?:Name|PageName|PageLink)>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(rawXml)) !== null) {
    const t = normalizeTextStrict(m[1]);
    if (t) out.push(t);
  }
  return out;
}

export function buildComparisonContext(pageImportHash?: string | null): ComparisonContext {
  return {
    projectionVersion: CATALOG_COMPARISON_PROJECTION_VERSION,
    builtInPolicyVersion: SHOP_SITE_BUILT_IN_OUTPUT_POLICY_VERSION,
    fieldCatalogVersion: SHOP_SITE_FIELD_CATALOG_VERSION,
    pageImportHash: pageImportHash ?? null,
  };
}

export function isComparisonContextStale(
  recorded: ComparisonContext,
  current: ComparisonContext,
): boolean {
  return (
    recorded.projectionVersion !== current.projectionVersion ||
    recorded.builtInPolicyVersion !== current.builtInPolicyVersion ||
    recorded.fieldCatalogVersion !== current.fieldCatalogVersion ||
    (recorded.pageImportHash ?? null) !== (current.pageImportHash ?? null)
  );
}

/**
 * Build the canonical comparison projection for one product.
 * Excludes transient identity (id, timestamps, pulled/synced hashes,
 * xmlVersion, source pointers); applies DTD defaults, canonical
 * controlled-value identity, stable page identity, and preserved-data
 * normalization so semantically identical products compare equal.
 */
export function buildComparisonProjection(
  product: Product,
  options?: BuildComparisonOptions,
): ComparisonProjection {
  const controlledByField = options?.controlledByField;
  const fields: Record<string, string | null> = {};

  fields['sku'] = normalizeTextStrict(product.sku);
  fields['status'] = normalizeTextStrict(product.status);
  fields['core.name'] = normalizeTextStrict(product.core?.name);
  fields['core.price'] = normalizePrice(product.core?.price);
  fields['core.salePrice'] = normalizePrice(product.core?.salePrice);
  fields['core.description'] = normalizeTextStrict(product.core?.description);
  fields['core.weight'] = normalizeTextStrict(product.core?.weight);
  fields['core.taxable'] = product.core?.taxable == null ? null : String(!!product.core.taxable);
  fields['core.availability'] = resolveControlled(
    normalizeTextStrict(product.core?.availability),
    'core.availability',
    controlledByField,
  );
  fields['core.quantityOnHand'] = normalizeQuantity(product.core?.inventory?.quantityOnHand);
  fields['core.media.primary'] = normalizeImagePath(product.core?.media?.primary);
  const additional = product.core?.media?.additional ?? [];
  const normalizedAdditional = additional
    .map(normalizeImagePath)
    .filter((v): v is string => v != null);
  fields['core.media.additional'] = normalizedAdditional.length > 0 ? JSON.stringify(normalizedAdditional) : null;
  fields['seo.fileName'] = normalizeFileNameValue(product.core?.seo?.fileName);
  fields['seo.searchKeywords'] = normalizeCollapsed(product.core?.seo?.searchKeywords);

  const minQty = resolveEffectiveCustom(product, 'MinimumQuantity') ?? '0';
  fields['custom.MinimumQuantity'] = normalizeQuantity(minQty);
  const productType = resolveEffectiveCustom(product, 'ProductType') ?? 'Tangible';
  fields['custom.ProductType'] = resolveControlled(
    normalizeTextStrict(productType),
    'custom.ProductType',
    controlledByField,
  );

  const seenCustom = new Set(['MinimumQuantity', 'ProductType']);
  for (const [tag, value] of Object.entries(product.customFields ?? {})) {
    if (seenCustom.has(tag)) continue;
    seenCustom.add(tag);
    const key = `custom.${tag}`;
    if (controlledByField?.[key]) {
      fields[key] = resolveControlled(normalizeTextStrict(value), key, controlledByField);
    } else if (tag === 'FileName') {
      fields[key] = normalizeFileNameValue(value);
    } else {
      fields[key] = normalizeTextStrict(value);
    }
  }
  const preserved: Record<string, string> = {};
  // Unmodeled data only: tags already covered by canonical field identities
  // (MinimumQuantity/ProductType/FileName) live in `fields` with DTD defaults
  // applied, so they must not also compare as preserved — otherwise an
  // explicit default vs a missing default would false-positive.
  for (const [tag, value] of Object.entries(product.shopsite?.preserved?.unknownElements ?? {})) {
    if (tag === 'ProductOnPages' || tag === 'productOnPages') continue;
    if (tag === 'MinimumQuantity' || tag === 'ProductType' || tag === 'FileName') continue;
    const t = normalizeTextStrict(value as unknown);
    if (t != null) preserved[`unknown:${tag}`] = t;
  }
  for (const [tag, value] of Object.entries(product.shopsite?.preserved?.advancedBlocks ?? {})) {
    if (tag.toLowerCase() === 'productonpages') continue;
    const t = normalizeAdvancedBlock(value);
    if (t != null) preserved[`block:${tag}`] = t;
  }

  const pages = resolvePageIdentities(product, options?.resolvePageIdentity);

  return {
    version: CATALOG_COMPARISON_PROJECTION_VERSION,
    sku: normalizeTextStrict(product.sku) ?? '',
    fields,
    pages,
    preserved,
  };
}

/** Canonical comparison hash: stable over semantically identical products. */
export function hashComparisonProjection(projection: ComparisonProjection): string {
  return hashCanonicalJson({
    version: projection.version,
    sku: projection.sku,
    fields: projection.fields,
    pages: projection.pages,
    preserved: projection.preserved,
  });
}

export function comparisonHashForProduct(product: Product, options?: BuildComparisonOptions): string {
  return hashComparisonProjection(buildComparisonProjection(product, options));
}

/**
 * Exact field-level hunks between baseline and remote projections.
 * Pages diff as added/removed stable identities; preserved entries diff per tag.
 */
export function diffComparisonProjections(
  baseline: ComparisonProjection | null,
  remote: ComparisonProjection,
): FieldHunk[] {
  const hunks: FieldHunk[] = [];
  if (!baseline) {
    for (const [field, remoteValue] of Object.entries(remote.fields)) {
      if (remoteValue != null) hunks.push({ field, baselineValue: null, remoteValue });
    }
    for (const page of remote.pages) {
      hunks.push({ field: 'core.productOnPages', baselineValue: null, remoteValue: page });
    }
    for (const [tag, remoteValue] of Object.entries(remote.preserved)) {
      hunks.push({ field: `preserved.${tag}`, baselineValue: null, remoteValue });
    }
    return hunks.sort((a, b) => a.field.localeCompare(b.field));
  }

  const allFields = new Set([...Object.keys(baseline.fields), ...Object.keys(remote.fields)]);
  for (const field of allFields) {
    const b = baseline.fields[field] ?? null;
    const r = remote.fields[field] ?? null;
    if (b !== r) hunks.push({ field, baselineValue: b, remoteValue: r });
  }

  const bPages = new Set(baseline.pages);
  const rPages = new Set(remote.pages);
  for (const page of rPages) {
    if (!bPages.has(page)) hunks.push({ field: 'core.productOnPages', baselineValue: null, remoteValue: page });
  }
  for (const page of bPages) {
    if (!rPages.has(page)) hunks.push({ field: 'core.productOnPages', baselineValue: page, remoteValue: null });
  }

  const allPreserved = new Set([...Object.keys(baseline.preserved), ...Object.keys(remote.preserved)]);
  for (const tag of allPreserved) {
    const b = baseline.preserved[tag] ?? null;
    const r = remote.preserved[tag] ?? null;
    if (b !== r) hunks.push({ field: `preserved.${tag}`, baselineValue: b, remoteValue: r });
  }

  return hunks.sort((a, b) => {
    const c = a.field.localeCompare(b.field);
    if (c !== 0) return c;
    return String(a.remoteValue ?? '').localeCompare(String(b.remoteValue ?? ''));
  });
}
