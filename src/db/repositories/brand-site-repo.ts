import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import type { BrandSite } from '../../shared/schemas/onboarding';

export interface BrandSiteRow {
  id: string;
  brand_name: string;
  domain: string;
  url_pattern: string | null;
  success_count: number;
  last_used_at: string | null;
  source_strategy?: string | null;
  created_at: string;
}

function mapRowToBrandSite(row: BrandSiteRow): BrandSite {
  return {
    id: row.id,
    brandName: row.brand_name,
    domain: row.domain,
    urlPattern: row.url_pattern,
    successCount: row.success_count,
    lastUsedAt: row.last_used_at,
    sourceStrategy: (row.source_strategy as any) ?? 'official_first',
    createdAt: row.created_at,
  };
}

export function upsertBrandSite(
  brandName: string,
  domain: string,
  urlPattern?: string | null,
): BrandSite {
  const db = getDb();
  const now = new Date().toISOString();
  const normalizedBrand = brandName.toLowerCase().trim();
  const normalizedDomain = domain
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .trim();

  const existing = db.query(
    'SELECT * FROM brand_sites WHERE brand_name = ? AND domain = ?',
  ).get(normalizedBrand, normalizedDomain) as BrandSiteRow | undefined;

  if (existing) {
    db.query(
      `UPDATE brand_sites SET success_count = success_count + 1, last_used_at = ?
       ${urlPattern ? ', url_pattern = ?' : ''} WHERE id = ?`,
    ).run(...(urlPattern ? [now, urlPattern, existing.id] : [now, existing.id]));
    return {
      id: existing.id,
      brandName: normalizedBrand,
      domain: normalizedDomain,
      urlPattern: urlPattern ?? existing.url_pattern,
      successCount: existing.success_count + 1,
      lastUsedAt: now,
      sourceStrategy: (existing.source_strategy as any) ?? 'official_first',
      createdAt: existing.created_at,
    };
  }

  const id = randomUUID();
  db.query(
    `INSERT INTO brand_sites (id, brand_name, domain, url_pattern, success_count, last_used_at, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, normalizedBrand, normalizedDomain, urlPattern ?? null, now, now);

  return {
    id,
    brandName: normalizedBrand,
    domain: normalizedDomain,
    urlPattern: urlPattern ?? null,
    successCount: 1,
    lastUsedAt: now,
    sourceStrategy: 'official_first',
    createdAt: now,
  };
}

/**
 * ADR 0017 commitment 1 — atomic first-mapping-wins insert used for
 * provisional inferred-domain persistence. A single guarded INSERT statement
 * (never a read-then-write pair) guarantees that only the FIRST mapping for a
 * brand is ever created: once ANY `brand_sites` row exists for the brand, the
 * insert no-ops even when two workers infer the same brand concurrently with
 * different domains. `upsertBrandSite` (increment-on-repeat, operator/route
 * use) is intentionally untouched.
 *
 * Returns the brand→domain row: the just-created row, or the pre-existing row
 * for the same (brand, domain). Returns null when the guarded insert was
 * skipped because a DIFFERENT domain already holds the brand's first mapping
 * (the caller's candidate never became the mapping). Existing rows are never
 * modified — no success_count increment, no url_pattern overwrite.
 */
export function insertBrandSiteIfAbsent(
  brandName: string,
  domain: string,
  urlPattern?: string | null,
): BrandSite | null {
  const db = getDb();
  const now = new Date().toISOString();
  const normalizedBrand = brandName.toLowerCase().trim();
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, '').trim();
  const id = randomUUID();

  db.query(
    `INSERT INTO brand_sites (id, brand_name, domain, url_pattern, success_count, last_used_at, created_at)
     SELECT ?, ?, ?, ?, 1, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM brand_sites WHERE brand_name = ?)`,
  ).run(id, normalizedBrand, normalizedDomain, urlPattern ?? null, now, now, normalizedBrand);

  const row = db.query(
    'SELECT * FROM brand_sites WHERE brand_name = ? AND domain = ?',
  ).get(normalizedBrand, normalizedDomain) as BrandSiteRow | undefined;
  if (row) return mapRowToBrandSite(row);

  // The guarded insert was skipped because a different domain already holds
  // the brand's first mapping — this call did not create (or match) a row.
  return null;
}

export function findBrandSites(brandName: string): BrandSite[] {
  const db = getDb();
  const normalizedBrand = brandName.toLowerCase().trim();
  const rows = db.query(
    'SELECT * FROM brand_sites WHERE brand_name = ? ORDER BY success_count DESC',
  ).all(normalizedBrand) as BrandSiteRow[];
  return rows.map(mapRowToBrandSite);
}

export function listAllBrandSites(): BrandSite[] {
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM brand_sites ORDER BY brand_name, success_count DESC',
  ).all() as BrandSiteRow[];
  return rows.map(mapRowToBrandSite);
}

export function deleteBrandSite(id: string): boolean {
  const db = getDb();
  const result = db.query('DELETE FROM brand_sites WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Builder slice B1: brand-scoped mapping delta primitives.
 *
 * Unlike `upsertBrandSite` (which increments `success_count` on repeat use)
 * these helpers never manufacture usage: adds insert with `success_count 0`
 * and leave existing rows (ids, counters, timestamps, url_pattern) fully
 * untouched; removals delete only this brand's pair. Callers own the
 * surrounding transaction. Never touches other brands sharing the domain.
 */
export function addBrandSiteMapping(brandName: string, domain: string): BrandSite {
  const db = getDb();
  const now = new Date().toISOString();
  const normalizedBrand = brandName.toLowerCase().trim();
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, '').trim();
  db.query(
    `INSERT OR IGNORE INTO brand_sites (id, brand_name, domain, url_pattern, success_count, last_used_at, created_at)
     VALUES (?, ?, ?, NULL, 0, NULL, ?)`,
  ).run(randomUUID(), normalizedBrand, normalizedDomain, now);
  const row = db.query(
    'SELECT * FROM brand_sites WHERE brand_name = ? AND domain = ?',
  ).get(normalizedBrand, normalizedDomain) as BrandSiteRow | undefined;
  if (!row) throw new Error(`Failed to add brand site mapping for '${normalizedBrand}'`);
  return mapRowToBrandSite(row);
}

export function removeBrandSiteMapping(brandName: string, domain: string): boolean {
  const db = getDb();
  const normalizedBrand = brandName.toLowerCase().trim();
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, '').trim();
  const result = db.query(
    'DELETE FROM brand_sites WHERE brand_name = ? AND domain = ?',
  ).run(normalizedBrand, normalizedDomain);
  return result.changes > 0;
}

export function deleteBrandSitesByDomain(domain: string): number {
  const db = getDb();
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, '').trim();
  const result = db.query('DELETE FROM brand_sites WHERE domain = ?').run(normalizedDomain);
  return result.changes;
}

export function updateBrandSiteDomain(brandName: string, domain: string): BrandSite {
  const db = getDb();
  const now = new Date().toISOString();
  const normalizedBrand = brandName.toLowerCase().trim();
  const normalizedDomain = domain.toLowerCase().replace(/^www\./, '').trim();

  // Find all existing brand site rows for this brand
  const existingRows = db.query('SELECT * FROM brand_sites WHERE brand_name = ?').all(normalizedBrand) as BrandSiteRow[];
  
  if (existingRows.length > 0) {
    // Update the first one, delete the rest to avoid duplicates/confusion
    const mainRow = existingRows[0];
    db.query('UPDATE brand_sites SET domain = ?, success_count = success_count + 1, last_used_at = ? WHERE id = ?')
      .run(normalizedDomain, now, mainRow.id);
      
    for (let i = 1; i < existingRows.length; i++) {
      db.query('DELETE FROM brand_sites WHERE id = ?').run(existingRows[i].id);
    }
    
    return {
      id: mainRow.id,
      brandName: normalizedBrand,
      domain: normalizedDomain,
      urlPattern: mainRow.url_pattern,
      successCount: mainRow.success_count + 1,
      lastUsedAt: now,
      sourceStrategy: (mainRow.source_strategy as any) ?? 'official_first',
      createdAt: mainRow.created_at,
    };
  } else {
    // Create new
    return upsertBrandSite(brandName, domain);
  }
}

