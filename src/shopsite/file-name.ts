import type { Product } from '../shared/types';

/**
 * More-information page file-name handling (issue #107).
 *
 * ShopSite `<FileName>` is the product-detail HTML file from which the More
 * Info page derives. It MUST be unique per product: identical names used to
 * slug to byte-identical file names with no check at any stage, cross-linking
 * ~100 products' detail pages.
 *
 * Resolution precedence (first non-blank wins):
 *   explicit customFields['FileName'] → preserved import value →
 *   persisted per-source-URL slug (core.seo.fileName) → slug of core.name →
 *   slug of the SKU (punctuation-only names slug to a bare extension).
 *
 * Batch/catalog uniqueness is enforced separately by `uniquifyFileNames`
 * (Promotion persist + batch XML export) and `findDuplicateFileNames`
 * (pre-sync change-set validation backstop).
 */

export const FILE_NAME_STEM_LIMIT = 80;
export const FILE_NAME_EXTENSION = '.html';

/**
 * Slugify a draft name into a ShopSite file name.
 * Lowercase, non-alphanumerics collapse to '-', stem truncated to 80 chars.
 */
export function slugifyFileName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, FILE_NAME_STEM_LIMIT) + FILE_NAME_EXTENSION
  );
}

/**
 * Normalize a stored file-name value to a single `.html` form.
 * Returns null for blank values and bare extensions (caller falls through
 * to the next source).
 */
export function normalizeFileName(value: unknown): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (/^\.html$/i.test(trimmed)) return null;
  if (/\.html$/i.test(trimmed)) return trimmed;
  return trimmed + FILE_NAME_EXTENSION;
}

/**
 * Where a product's base file name comes from (precedence order).
 * `explicit`/`preserved` are kept live names — never renamed silently.
 */
export type BaseFileNameSource = 'explicit' | 'preserved' | 'seo' | 'derived';

export function classifyBaseFileNameSource(product: Product): BaseFileNameSource {
  if (normalizeFileName(product.customFields['FileName'])) return 'explicit';
  if (normalizeFileName(product.shopsite.preserved.unknownElements['FileName'])) return 'preserved';
  if (normalizeFileName(product.core.seo.fileName)) return 'seo';
  return 'derived';
}

export type ReimportFilenameDisposition =
  | { action: 'preserve'; name: string }
  | { action: 'allocate_free' }
  | { action: 'hold_collision'; name: string; code: 'IMPORT_FILENAME_COLLISION'; ownerSku: string };

/**
 * Collision-aware re-import preservation (issue #106 SEQUENCE 2e).
 *
 * - Pulled name unowned, or owned by THIS sku → preserve (live pages are
 *   never renamed automatically).
 * - Pulled name owned by ANOTHER sku → hold with IMPORT_FILENAME_COLLISION
 *   (operator repair goes through the normal reviewed flow).
 * - Blank pulled name → allocate_free (a new name is derived at promotion).
 *
 * Pure: `owners` maps lowercased name → owning sku. No healed-heuristic,
 * no grandfathering of kept collisions.
 */
export function resolveReimportFilename(
  pulledName: unknown,
  sku: string,
  owners: Map<string, string>,
): ReimportFilenameDisposition {
  const normalized = normalizeFileName(pulledName);
  if (!normalized) return { action: 'allocate_free' };
  const owner = owners.get(normalized.toLowerCase());
  if (!owner || owner === sku) return { action: 'preserve', name: normalized };
  return { action: 'hold_collision', name: normalized, code: 'IMPORT_FILENAME_COLLISION', ownerSku: owner };
}

/**
 * Resolve the effective base file name for one product (no uniqueness).
 */
export function resolveBaseFileName(product: Product): string {
  const explicit = normalizeFileName(product.customFields['FileName']);
  if (explicit) return explicit;
  const preserved = normalizeFileName(product.shopsite.preserved.unknownElements['FileName']);
  if (preserved) return preserved;
  const seoSlug = normalizeFileName(product.core.seo.fileName);
  if (seoSlug) return seoSlug;
  // Punctuation-only names slug to a bare extension — fall back to the SKU
  // so every product still resolves to a meaningful base name.
  const slug = slugifyFileName(product.core.name ?? '');
  if (slug !== FILE_NAME_EXTENSION) return slug;
  return slugifyFileName(product.sku);
}

export interface FileNameEntry {
  /** Stable unique key (SKU / item id). */
  key: string;
  fileName: string;
}

/**
 * Assign a distinct file name per entry, deterministically.
 *
 * Entries are processed in ascending key order so the assignment is
 * independent of input order (reruns reproduce it). Keys MUST be unique per
 * entry — duplicate keys collapse in the result map (callers with
 * non-unique natural keys must disambiguate, e.g. with a positional suffix). The first claimant keeps
 * the base name; later claimants get `-2`, `-3`, … inserted before `.html`,
 * with the stem shortened to keep the total stem within the 80-char limit.
 * Comparison is case-insensitive, and names in `taken` (e.g. the live
 * catalog) are treated as already claimed.
 */
export function uniquifyFileNames(
  entries: FileNameEntry[],
  taken: Iterable<string> = [],
): Map<string, string> {
  const used = new Set<string>();
  for (const t of taken) used.add(t.toLowerCase());

  const assigned = new Map<string, string>();
  const ordered = [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const entry of ordered) {
    const normalized = normalizeFileName(entry.fileName) ?? slugifyFileName(entry.key);
    const lower = normalized.toLowerCase();
    if (!used.has(lower)) {
      used.add(lower);
      assigned.set(entry.key, normalized);
      continue;
    }
    const dot = normalized.lastIndexOf('.');
    const stem = dot >= 0 ? normalized.slice(0, dot) : normalized;
    const ext = dot >= 0 ? normalized.slice(dot) : FILE_NAME_EXTENSION;
    let counter = 2;
    for (;;) {
      const suffix = `-${counter}`;
      const room = FILE_NAME_STEM_LIMIT - suffix.length;
      const candidate = `${stem.slice(0, room).replace(/-+$/, '')}${suffix}${ext}`;
      if (!used.has(candidate.toLowerCase())) {
        used.add(candidate.toLowerCase());
        assigned.set(entry.key, candidate);
        break;
      }
      counter++;
    }
  }
  return assigned;
}

export interface DuplicateFileNameGroup {
  /** File name as first seen (comparison is case-insensitive). */
  fileName: string;
  keys: string[];
}

/**
 * Group entries whose effective file names collide (case-insensitive).
 * Used by pre-sync change-set validation to fail closed with a reviewable
 * error instead of exporting cross-linked detail pages.
 */
export function findDuplicateFileNames(entries: FileNameEntry[]): DuplicateFileNameGroup[] {
  const byName = new Map<string, { fileName: string; keys: string[] }>();
  for (const entry of entries) {
    const normalized = normalizeFileName(entry.fileName) ?? slugifyFileName(entry.key);
    const lower = normalized.toLowerCase();
    const group = byName.get(lower);
    if (group) {
      group.keys.push(entry.key);
    } else {
      byName.set(lower, { fileName: normalized, keys: [entry.key] });
    }
  }
  return [...byName.values()].filter(g => g.keys.length > 1);
}
