import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';

export type BrandUrlPageType = 'product' | 'category' | 'article' | 'other' | 'unknown';

export interface BrandUrlRecord {
  id: string;
  domain: string;
  url: string;
  canonical_url: string | null;
  path: string;
  slug: string | null;
  page_type: BrandUrlPageType;
  sitemap_source_url: string | null;
  first_seen_at: string;
  last_seen_at: string;
  last_sitemap_refresh_at: string;
  active: number;
  lastmod: string | null;
  title: string | null;
  h1: string | null;
  upc: string | null;
  sku: string | null;
  mpn: string | null;
  brand: string | null;
  variant_tokens_json: string | null;
  json_ld_identifiers_json: string | null;
  last_fetched_at: string | null;
  extraction_status: string | null;
}

export interface ReconcileResult {
  addedCount: number;
  updatedCount: number;
  inactivatedCount: number;
  totalActiveCount: number;
}

export interface EnrichedUrlMetadata {
  title?: string | null;
  h1?: string | null;
  upc?: string | null;
  sku?: string | null;
  mpn?: string | null;
  brand?: string | null;
  variantTokens?: string[];
  jsonLdIdentifiers?: Record<string, unknown> | null;
  extractionStatus?: string | null;
  lastFetchedAt?: string | null;
}

export interface DomainUrlCounts {
  totalCount: number;
  activeCount: number;
  inactiveCount: number;
  productCount: number;
}

/**
 * Normalizes a domain name by lowercasing and stripping www.
 */
export function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].trim();
}

/**
 * Parses path and slug from a URL string.
 */
export function parseUrlPathAndSlug(urlStr: string): { path: string; slug: string } {
  try {
    const parsed = new URL(urlStr);
    const path = parsed.pathname;
    const segments = path.split('/').filter(Boolean);
    const slug = segments[segments.length - 1] || '';
    return { path, slug };
  } catch {
    return { path: urlStr, slug: '' };
  }
}

/**
 * Reconciles discovered sitemap URLs against the persistent brand_url_index.
 * - Inserts new URLs as active=1
 * - Updates existing URLs (last_seen_at, last_sitemap_refresh_at, lastmod, active=1)
 * - Marks previously active URLs not seen in this sitemap run as active=0
 * - Keeps FTS5 table in sync
 */
export function reconcileSitemapUrls(
  domain: string,
  observedUrls: Array<{ url: string; lastmod?: string | null; pageType?: BrandUrlPageType }>,
  sourceUrl: string,
  nowIso: string = new Date().toISOString(),
): ReconcileResult {
  const db = getDb();
  const normDomain = normalizeDomain(domain);

  return db.transaction(() => {
    // 1. Fetch all currently known URLs for this domain
    const existingRows = db
      .query('SELECT url, active FROM brand_url_index WHERE domain = ?')
      .all(normDomain) as Array<{ url: string; active: number }>;

    const existingMap = new Map<string, number>();
    for (const row of existingRows) {
      existingMap.set(row.url, row.active);
    }

    const observedUrlSet = new Set<string>();
    let addedCount = 0;
    let updatedCount = 0;

    const insertStmt = db.prepare(`
      INSERT INTO brand_url_index (
        id, domain, url, path, slug, page_type, sitemap_source_url,
        first_seen_at, last_seen_at, last_sitemap_refresh_at, active, lastmod
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `);

    const updateStmt = db.prepare(`
      UPDATE brand_url_index
      SET last_seen_at = ?,
          last_sitemap_refresh_at = ?,
          sitemap_source_url = ?,
          active = 1,
          lastmod = COALESCE(?, lastmod),
          page_type = COALESCE(?, page_type)
      WHERE domain = ? AND url = ?
    `);

    const ftsInsert = db.prepare(`
      INSERT INTO brand_url_fts (rowid, domain, url, path, slug, title, h1, brand)
      SELECT rowid, domain, url, path, slug, title, h1, brand FROM brand_url_index WHERE domain = ? AND url = ?
    `);

    for (const item of observedUrls) {
      const u = item.url.trim();
      if (!u || !u.startsWith('http')) continue;
      if (observedUrlSet.has(u)) continue;
      observedUrlSet.add(u);

      const existingActive = existingMap.get(u);
      if (existingActive === undefined) {
        // New URL
        const { path, slug } = parseUrlPathAndSlug(u);
        const pageType = item.pageType || 'product';
        const id = `bui_${randomUUID()}`;
        insertStmt.run(
          id,
          normDomain,
          u,
          path,
          slug,
          pageType,
          sourceUrl,
          nowIso,
          nowIso,
          nowIso,
          item.lastmod || null,
        );
        ftsInsert.run(normDomain, u);
        addedCount++;
      } else {
        // Existing URL
        updateStmt.run(
          nowIso,
          nowIso,
          sourceUrl,
          item.lastmod || null,
          item.pageType || null,
          normDomain,
          u,
        );
        updatedCount++;
      }
    }

    // 2. Inactivate URLs that were previously active but missing in this sitemap run
    let inactivatedCount = 0;
    const inactivateStmt = db.prepare(`
      UPDATE brand_url_index
      SET active = 0, last_sitemap_refresh_at = ?
      WHERE domain = ? AND url = ?
    `);

    for (const [existingUrl, active] of existingMap.entries()) {
      if (active === 1 && !observedUrlSet.has(existingUrl)) {
        inactivateStmt.run(nowIso, normDomain, existingUrl);
        inactivatedCount++;
      }
    }

    // Count total active
    const totalActiveRow = db
      .query('SELECT COUNT(*) as count FROM brand_url_index WHERE domain = ? AND active = 1')
      .get(normDomain) as { count: number };

    return {
      addedCount,
      updatedCount,
      inactivatedCount,
      totalActiveCount: totalActiveRow?.count ?? 0,
    };
  })();
}

/**
 * Paginated and searchable listing of indexed URLs for a domain.
 */
export function findUrlsByDomain(
  domain: string,
  options?: {
    pageType?: BrandUrlPageType | 'all';
    activeOnly?: boolean;
    search?: string;
    limit?: number;
    offset?: number;
  },
): { urls: BrandUrlRecord[]; total: number } {
  const db = getDb();
  const normDomain = normalizeDomain(domain);
  const conditions: string[] = ['domain = ?'];
  const params: (string | number)[] = [normDomain];

  if (options?.activeOnly !== false) {
    conditions.push('active = 1');
  }

  if (options?.pageType && options.pageType !== 'all') {
    conditions.push('page_type = ?');
    params.push(options.pageType);
  }

  if (options?.search && options.search.trim()) {
    const term = `%${options.search.trim().toLowerCase()}%`;
    conditions.push('(LOWER(url) LIKE ? OR LOWER(title) LIKE ? OR upc LIKE ? OR LOWER(sku) LIKE ? OR LOWER(slug) LIKE ?)');
    params.push(term, term, term, term, term);
  }

  const whereClause = conditions.join(' AND ');

  const countRow = db
    .query(`SELECT COUNT(*) as total FROM brand_url_index WHERE ${whereClause}`)
    .get(...params) as { total: number };
  const total = countRow?.total ?? 0;

  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;

  const rows = db
    .query(`SELECT * FROM brand_url_index WHERE ${whereClause} ORDER BY active DESC, last_seen_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as BrandUrlRecord[];

  return { urls: rows, total };
}

/**
 * Look up a URL in a domain by exact UPC.
 * Checks both the enriched `upc` column and UPC digits appearing in the URL path/slug.
 */
export function lookupByUpc(domain: string, upc: string): BrandUrlRecord | null {
  const db = getDb();
  const normDomain = normalizeDomain(domain);
  const cleanUpc = upc.replace(/\D/g, '').trim();
  if (!cleanUpc) return null;

  // 1. Direct indexed match on enriched upc column
  const directRow = db
    .query('SELECT * FROM brand_url_index WHERE domain = ? AND upc = ? AND active = 1 LIMIT 1')
    .get(normDomain, cleanUpc) as BrandUrlRecord | undefined;

  if (directRow) return directRow;

  // 2. Substring search in path / slug
  const pattern = `%${cleanUpc}%`;
  const urlRow = db
    .query('SELECT * FROM brand_url_index WHERE domain = ? AND (path LIKE ? OR slug LIKE ?) AND active = 1 ORDER BY last_seen_at DESC LIMIT 1')
    .get(normDomain, pattern, pattern) as BrandUrlRecord | undefined;

  return urlRow ?? null;
}

/**
 * Look up a URL in a domain by exact SKU / MPN.
 */
export function lookupBySku(domain: string, sku: string): BrandUrlRecord | null {
  const db = getDb();
  const normDomain = normalizeDomain(domain);
  const cleanSku = sku.trim().toLowerCase();
  if (!cleanSku) return null;

  const row = db
    .query('SELECT * FROM brand_url_index WHERE domain = ? AND (LOWER(sku) = ? OR LOWER(mpn) = ?) AND active = 1 LIMIT 1')
    .get(normDomain, cleanSku, cleanSku) as BrandUrlRecord | undefined;

  return row ?? null;
}

/**
 * Performs fast FTS5 lexical matching for candidate search within a domain.
 */
export function searchUrlsLexical(
  domain: string,
  query: string,
  limit: number = 20,
): BrandUrlRecord[] {
  const db = getDb();
  const normDomain = normalizeDomain(domain);
  const cleanQuery = query
    .replace(/[^\w\s-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .join(' OR ');

  if (!cleanQuery) return [];

  try {
    const ftsRows = db
      .query(`
        SELECT b.*, bm25(brand_url_fts) as rank
        FROM brand_url_fts f
        JOIN brand_url_index b ON b.rowid = f.rowid
        WHERE brand_url_fts MATCH ? AND b.domain = ? AND b.active = 1
        ORDER BY rank
        LIMIT ?
      `)
      .all(cleanQuery, normDomain, limit) as BrandUrlRecord[];

    return ftsRows;
  } catch (err) {
    // If FTS fails (e.g. malformed query), fall back to simple LIKE query
    const tokens = query.split(/\s+/).filter((t) => t.length > 2);
    if (tokens.length === 0) return [];
    const likeClauses = tokens.map(() => 'LOWER(slug) LIKE ?').join(' OR ');
    const params = tokens.map((t) => `%${t.toLowerCase()}%`);

    return db
      .query(`
        SELECT * FROM brand_url_index
        WHERE domain = ? AND active = 1 AND (${likeClauses})
        LIMIT ?
      `)
      .all(normDomain, ...params, limit) as BrandUrlRecord[];
  }
}

/**
 * Enrich a URL with extracted metadata (UPC, SKU, MPN, Title, H1, JSON-LD identifiers).
 * Updates both the main table and syncs the FTS5 virtual index.
 */
export function enrichUrlMetadata(
  url: string,
  metadata: EnrichedUrlMetadata,
): boolean {
  const db = getDb();
  const nowIso = metadata.lastFetchedAt || new Date().toISOString();

  const existing = db
    .query('SELECT rowid, id, domain, title, h1, brand FROM brand_url_index WHERE url = ?')
    .get(url) as { rowid: number; id: string; domain: string; title: string | null; h1: string | null; brand: string | null } | undefined;

  if (!existing) return false;

  const variantJson = metadata.variantTokens ? JSON.stringify(metadata.variantTokens) : null;
  const jsonLdJson = metadata.jsonLdIdentifiers ? JSON.stringify(metadata.jsonLdIdentifiers) : null;

  db.transaction(() => {
    db.prepare(`
      UPDATE brand_url_index
      SET title = COALESCE(?, title),
          h1 = COALESCE(?, h1),
          upc = COALESCE(?, upc),
          sku = COALESCE(?, sku),
          mpn = COALESCE(?, mpn),
          brand = COALESCE(?, brand),
          variant_tokens_json = COALESCE(?, variant_tokens_json),
          json_ld_identifiers_json = COALESCE(?, json_ld_identifiers_json),
          extraction_status = COALESCE(?, extraction_status),
          last_fetched_at = ?
      WHERE url = ?
    `).run(
      metadata.title || null,
      metadata.h1 || null,
      metadata.upc || null,
      metadata.sku || null,
      metadata.mpn || null,
      metadata.brand || null,
      variantJson,
      jsonLdJson,
      metadata.extractionStatus || 'success',
      nowIso,
      url,
    );

    // Update FTS5 record
    try {
      db.prepare('DELETE FROM brand_url_fts WHERE rowid = ?').run(existing.rowid);
      db.prepare(`
        INSERT INTO brand_url_fts (rowid, domain, url, path, slug, title, h1, brand)
        SELECT rowid, domain, url, path, slug, title, h1, brand FROM brand_url_index WHERE rowid = ?
      `).run(existing.rowid);
    } catch {
      // FTS sync failure is non-fatal
    }
  })();

  return true;
}

/**
 * Returns URL counts for a domain.
 */
export function getDomainUrlCounts(domain: string): DomainUrlCounts {
  const db = getDb();
  const normDomain = normalizeDomain(domain);

  const row = db
    .query(`
      SELECT
        COUNT(*) as totalCount,
        SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) as activeCount,
        SUM(CASE WHEN active = 0 THEN 1 ELSE 0 END) as inactiveCount,
        SUM(CASE WHEN active = 1 AND page_type = 'product' THEN 1 ELSE 0 END) as productCount
      FROM brand_url_index
      WHERE domain = ?
    `)
    .get(normDomain) as {
    totalCount: number;
    activeCount: number | null;
    inactiveCount: number | null;
    productCount: number | null;
  };

  return {
    totalCount: row?.totalCount ?? 0,
    activeCount: row?.activeCount ?? 0,
    inactiveCount: row?.inactiveCount ?? 0,
    productCount: row?.productCount ?? 0,
  };
}

/**
 * Returns URL counts for all domains.
 */
export function getAllDomainUrlCounts(): Record<string, DomainUrlCounts> {
  const db = getDb();
  const rows = db
    .query(`
      SELECT
        domain,
        COUNT(*) as totalCount,
        SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) as activeCount,
        SUM(CASE WHEN active = 0 THEN 1 ELSE 0 END) as inactiveCount,
        SUM(CASE WHEN active = 1 AND page_type = 'product' THEN 1 ELSE 0 END) as productCount
      FROM brand_url_index
      GROUP BY domain
    `)
    .all() as Array<{
    domain: string;
    totalCount: number;
    activeCount: number | null;
    inactiveCount: number | null;
    productCount: number | null;
  }>;

  const result: Record<string, DomainUrlCounts> = {};
  for (const r of rows) {
    result[r.domain] = {
      totalCount: r.totalCount,
      activeCount: r.activeCount ?? 0,
      inactiveCount: r.inactiveCount ?? 0,
      productCount: r.productCount ?? 0,
    };
  }
  return result;
}

/**
 * Returns active URLs list for a domain.
 */
export function getActiveUrlsForDomain(domain: string, pageType?: BrandUrlPageType): string[] {
  const db = getDb();
  const normDomain = normalizeDomain(domain);
  if (pageType) {
    const rows = db
      .query('SELECT url FROM brand_url_index WHERE domain = ? AND active = 1 AND page_type = ? ORDER BY last_seen_at DESC')
      .all(normDomain, pageType) as Array<{ url: string }>;
    return rows.map((r) => r.url);
  }
  const rows = db
    .query('SELECT url FROM brand_url_index WHERE domain = ? AND active = 1 ORDER BY last_seen_at DESC')
    .all(normDomain) as Array<{ url: string }>;
  return rows.map((r) => r.url);
}

/**
 * Delete a specific URL record by ID from the index and sync FTS5.
 */
export function deleteBrandUrlById(id: string): boolean {
  const db = getDb();
  return db.transaction(() => {
    const row = db.query('SELECT rowid FROM brand_url_index WHERE id = ?').get(id) as { rowid: number } | undefined;
    if (!row) return false;
    try {
      db.prepare('DELETE FROM brand_url_fts WHERE rowid = ?').run(row.rowid);
    } catch {
      // FTS cleanup error is non-fatal
    }
    const result = db.prepare('DELETE FROM brand_url_index WHERE id = ?').run(id);
    return (result.changes ?? 0) > 0;
  })();
}

/**
 * Batch delete specific URL records by an array of IDs and sync FTS5.
 */
export function deleteBrandUrlsByIds(ids: string[]): number {
  if (ids.length === 0) return 0;
  const db = getDb();
  return db.transaction(() => {
    let deletedCount = 0;
    const findStmt = db.prepare('SELECT rowid FROM brand_url_index WHERE id = ?');
    const ftsDeleteStmt = db.prepare('DELETE FROM brand_url_fts WHERE rowid = ?');
    const deleteStmt = db.prepare('DELETE FROM brand_url_index WHERE id = ?');

    for (const id of ids) {
      const row = findStmt.get(id) as { rowid: number } | undefined;
      if (row) {
        try {
          ftsDeleteStmt.run(row.rowid);
        } catch {
          // FTS cleanup error is non-fatal
        }
        const res = deleteStmt.run(id);
        if ((res.changes ?? 0) > 0) deletedCount++;
      }
    }
    return deletedCount;
  })();
}

/**
 * Delete all URLs for a given domain and sync FTS5.
 */
export function deleteBrandUrlsByDomain(domain: string): number {
  const db = getDb();
  const normDomain = normalizeDomain(domain);
  return db.transaction(() => {
    const rows = db.query('SELECT rowid FROM brand_url_index WHERE domain = ?').all(normDomain) as Array<{ rowid: number }>;
    if (rows.length === 0) return 0;
    const ftsDeleteStmt = db.prepare('DELETE FROM brand_url_fts WHERE rowid = ?');
    for (const row of rows) {
      try {
        ftsDeleteStmt.run(row.rowid);
      } catch {
        // ignore
      }
    }
    const result = db.prepare('DELETE FROM brand_url_index WHERE domain = ?').run(normDomain);
    return result.changes ?? 0;
  })();
}

export interface VariantUrlInput {
  url: string;
  baseUrl?: string | null;
  title?: string | null;
  upc?: string | null;
  sku?: string | null;
  mpn?: string | null;
  brand?: string | null;
  variantTokens?: string[];
  price?: number | null;
}

/**
 * Inserts or updates variant URLs with their specific UPCs, SKUs, and titles in brand_url_index.
 * This enables instant Tier 1 (UPC exact) and Tier 2 (SKU exact) lookups on variant URLs.
 */
export function indexVariantUrls(domain: string, variants: VariantUrlInput[]): number {
  if (variants.length === 0) return 0;
  const db = getDb();
  const normDomain = normalizeDomain(domain);
  const nowIso = new Date().toISOString();

  return db.transaction(() => {
    let affected = 0;
    const findStmt = db.prepare('SELECT rowid, id, upc, sku, title FROM brand_url_index WHERE domain = ? AND url = ?');
    const updateStmt = db.prepare(`
      UPDATE brand_url_index
      SET title = COALESCE(?, title),
          upc = COALESCE(?, upc),
          sku = COALESCE(?, sku),
          mpn = COALESCE(?, mpn),
          brand = COALESCE(?, brand),
          variant_tokens_json = COALESCE(?, variant_tokens_json),
          last_seen_at = ?,
          active = 1
      WHERE domain = ? AND url = ?
    `);
    const insertStmt = db.prepare(`
      INSERT INTO brand_url_index (
        id, domain, url, path, slug, page_type, sitemap_source_url,
        first_seen_at, last_seen_at, last_sitemap_refresh_at, active,
        title, upc, sku, mpn, brand, variant_tokens_json
      ) VALUES (?, ?, ?, ?, ?, 'product', 'variant_resolver', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
    `);
    const ftsDeleteStmt = db.prepare('DELETE FROM brand_url_fts WHERE rowid = ?');
    const ftsInsertStmt = db.prepare(`
      INSERT INTO brand_url_fts (rowid, domain, url, path, slug, title, h1, brand)
      SELECT rowid, domain, url, path, slug, title, h1, brand FROM brand_url_index WHERE rowid = ?
    `);

    for (const v of variants) {
      const u = v.url.trim();
      if (!u || !u.startsWith('http')) continue;

      const cleanUpc = v.upc ? v.upc.replace(/\D/g, '').trim() : null;
      const cleanSku = v.sku ? v.sku.trim() : null;
      const cleanMpn = v.mpn ? v.mpn.trim() : null;
      const variantJson = v.variantTokens && v.variantTokens.length > 0 ? JSON.stringify(v.variantTokens) : null;

      const existing = findStmt.get(normDomain, u) as { rowid: number; id: string; upc: string | null; sku: string | null; title: string | null } | undefined;

      if (existing) {
        updateStmt.run(
          v.title || null,
          cleanUpc,
          cleanSku,
          cleanMpn,
          v.brand || null,
          variantJson,
          nowIso,
          normDomain,
          u,
        );
        try {
          ftsDeleteStmt.run(existing.rowid);
          ftsInsertStmt.run(existing.rowid);
        } catch { /* non-fatal */ }
        affected++;
      } else {
        const { path, slug } = parseUrlPathAndSlug(u);
        const id = `bui_${randomUUID()}`;
        insertStmt.run(
          id,
          normDomain,
          u,
          path,
          slug,
          nowIso,
          nowIso,
          nowIso,
          v.title || null,
          cleanUpc,
          cleanSku,
          cleanMpn,
          v.brand || null,
          variantJson,
        );
        const newRow = db.query('SELECT rowid FROM brand_url_index WHERE id = ?').get(id) as { rowid: number } | undefined;
        if (newRow) {
          try {
            ftsInsertStmt.run(newRow.rowid);
          } catch { /* non-fatal */ }
        }
        affected++;
      }
    }
    return affected;
  })();
}


