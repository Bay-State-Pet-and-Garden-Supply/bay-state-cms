import { getDb } from '../connection';

export interface ProductIndexRow {
  id: string;
  sku: string;
  filePath: string;
  title: string;
  status: string;
  price: string | null;
  inventoryQuantity: number | null;
  primaryImage: string | null;
  productHash: string;
  lastApprovedCommit: string | null;
  lastPulledRemoteHash: string | null;
  lastSyncedRemoteHash: string | null;
  lastSyncedAt: string | null;
  syncStatus: string;
  hasAdvancedBlocks: number;
  hasWarnings: number;
  createdAt: string;
  updatedAt: string;
  description?: string | null;
  searchKeywords?: string | null;
  customFields?: Record<string, string>;
}

export function findProductBySku(sku: string): ProductIndexRow | null {
  const db = getDb();
  const row = db.query('SELECT * FROM product_index WHERE sku = ?').get(sku) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapRow(row);
}

export function listProducts(filter?: {
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
  minPrice?: string;
  maxPrice?: string;
  inventoryStatus?: string;
  customFilters?: Record<string, string>;
}): { products: ProductIndexRow[]; total: number } {
  const db = getDb();
  let whereSql = '';
  const conditions: string[] = [];
  const p: (string | number | null)[] = [];

  // Enabled / Disabled / Custom Status
  if (filter?.status) {
    if (filter.status === 'enabled') {
      conditions.push("status = 'active'");
    } else if (filter.status === 'disabled') {
      conditions.push("status IN ('draft', 'archived')");
    } else {
      conditions.push('status = ?');
      p.push(filter.status);
    }
  }

  // Advanced Search (SKU, Title, Description, Keywords, Custom Fields JSON)
  if (filter?.search) {
    conditions.push('(sku LIKE ? OR title LIKE ? OR description LIKE ? OR search_keywords LIKE ? OR custom_fields LIKE ?)');
    const term = `%${filter.search}%`;
    p.push(term, term, term, term, term);
  }

  // Price Range
  if (filter?.minPrice) {
    conditions.push('CAST(price AS REAL) >= ?');
    p.push(Number(filter.minPrice));
  }
  if (filter?.maxPrice) {
    conditions.push('CAST(price AS REAL) <= ?');
    p.push(Number(filter.maxPrice));
  }

  // Inventory Status
  if (filter?.inventoryStatus) {
    if (filter.inventoryStatus === 'in_stock') {
      conditions.push('inventory_quantity > 0');
    } else if (filter.inventoryStatus === 'out_of_stock') {
      conditions.push('(inventory_quantity IS NULL OR inventory_quantity <= 0)');
    } else if (filter.inventoryStatus === 'low_stock') {
      conditions.push('inventory_quantity > 0 AND inventory_quantity <= 5');
    }
  }

  // Custom Field Filters (e.g. Brand)
  if (filter?.customFilters) {
    for (const [field, val] of Object.entries(filter.customFilters)) {
      if (val && /^[a-zA-Z0-9_]+$/.test(field)) {
        conditions.push(`json_extract(custom_fields, '$.${field}') LIKE ?`);
        p.push(`%${val}%`);
      }
    }
  }

  if (conditions.length > 0) {
    whereSql = ' WHERE ' + conditions.join(' AND ');
  }

  // Get total count matching the criteria
  const countSql = `SELECT COUNT(*) as count FROM product_index${whereSql}`;
  const countRow = db.query(countSql).get(...p) as { count: number } | undefined;
  const total = countRow?.count ?? 0;

  // Get matching products with pagination
  let sql = `SELECT * FROM product_index${whereSql} ORDER BY title ASC`;
  const params = [...p];
  if (filter?.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(filter.limit);
  }
  if (filter?.offset !== undefined) {
    sql += ' OFFSET ?';
    params.push(filter.offset);
  }

  const rows = db.query(sql).all(...params) as Record<string, unknown>[];
  return {
    products: rows.map(mapRow),
    total,
  };
}

export function insertProductIndex(row: ProductIndexRow): void {
  const db = getDb();
  db.run(
    `INSERT INTO product_index (id, sku, file_path, title, status, price, inventory_quantity, primary_image,
       product_hash, last_approved_commit, last_pulled_remote_hash, last_synced_remote_hash,
       last_synced_at, sync_status, has_advanced_blocks, has_warnings, created_at, updated_at,
       description, search_keywords, custom_fields)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id, row.sku, row.filePath, row.title, row.status, row.price,
      row.inventoryQuantity, row.primaryImage, row.productHash,
      row.lastApprovedCommit, row.lastPulledRemoteHash, row.lastSyncedRemoteHash,
      row.lastSyncedAt, row.syncStatus, row.hasAdvancedBlocks, row.hasWarnings,
      row.createdAt, row.updatedAt,
      row.description ?? null, row.searchKeywords ?? null,
      row.customFields ? JSON.stringify(row.customFields) : null,
    ],
  );
}

function updateProductSyncStatus(sku: string, syncStatus: string): void {
  const db = getDb();
  db.run('UPDATE product_index SET sync_status = ?, updated_at = ? WHERE sku = ?', [
    syncStatus, new Date().toISOString(), sku,
  ]);
}

export function updateProductIndex(row: Partial<ProductIndexRow> & { sku: string }): void {
  const db = getDb();
  const now = new Date().toISOString();
  const sets: string[] = ['updated_at = ?'];
  const params: (string | number | null)[] = [now];

  if (row.title !== undefined) { sets.push('title = ?'); params.push(row.title); }
  if (row.status !== undefined) { sets.push('status = ?'); params.push(row.status); }
  if (row.price !== undefined) { sets.push('price = ?'); params.push(row.price); }
  if (row.inventoryQuantity !== undefined) { sets.push('inventory_quantity = ?'); params.push(row.inventoryQuantity); }
  if (row.primaryImage !== undefined) { sets.push('primary_image = ?'); params.push(row.primaryImage); }
  if (row.productHash !== undefined) { sets.push('product_hash = ?'); params.push(row.productHash); }
  if (row.lastApprovedCommit !== undefined) { sets.push('last_approved_commit = ?'); params.push(row.lastApprovedCommit); }
  if (row.lastPulledRemoteHash !== undefined) { sets.push('last_pulled_remote_hash = ?'); params.push(row.lastPulledRemoteHash); }
  if (row.lastSyncedRemoteHash !== undefined) { sets.push('last_synced_remote_hash = ?'); params.push(row.lastSyncedRemoteHash); }
  if (row.lastSyncedAt !== undefined) { sets.push('last_synced_at = ?'); params.push(row.lastSyncedAt); }
  if (row.syncStatus !== undefined) { sets.push('sync_status = ?'); params.push(row.syncStatus); }
  if (row.hasAdvancedBlocks !== undefined) { sets.push('has_advanced_blocks = ?'); params.push(row.hasAdvancedBlocks); }
  if (row.hasWarnings !== undefined) { sets.push('has_warnings = ?'); params.push(row.hasWarnings); }
  if (row.description !== undefined) { sets.push('description = ?'); params.push(row.description); }
  if (row.searchKeywords !== undefined) { sets.push('search_keywords = ?'); params.push(row.searchKeywords); }
  if (row.customFields !== undefined) { sets.push('custom_fields = ?'); params.push(row.customFields ? JSON.stringify(row.customFields) : null); }

  params.push(row.sku);
  db.run(`UPDATE product_index SET ${sets.join(', ')} WHERE sku = ?`, params);
}

function deleteProductIndex(sku: string): void {
  const db = getDb();
  db.run('DELETE FROM product_index WHERE sku = ?', [sku]);
}

function mapRow(row: Record<string, unknown>): ProductIndexRow {
  let customFieldsObj: Record<string, string> = {};
  if (row.custom_fields) {
    try {
      customFieldsObj = JSON.parse(String(row.custom_fields));
    } catch {
      // fallback
    }
  }

  return {
    id: String(row.id),
    sku: String(row.sku),
    filePath: String(row.file_path),
    title: String(row.title),
    status: String(row.status),
    price: row.price ? String(row.price) : null,
    inventoryQuantity: row.inventory_quantity != null ? Number(row.inventory_quantity) : null,
    primaryImage: row.primary_image ? String(row.primary_image) : null,
    productHash: String(row.product_hash),
    lastApprovedCommit: row.last_approved_commit ? String(row.last_approved_commit) : null,
    lastPulledRemoteHash: row.last_pulled_remote_hash ? String(row.last_pulled_remote_hash) : null,
    lastSyncedRemoteHash: row.last_synced_remote_hash ? String(row.last_synced_remote_hash) : null,
    lastSyncedAt: row.last_synced_at ? String(row.last_synced_at) : null,
    syncStatus: String(row.sync_status),
    hasAdvancedBlocks: Number(row.has_advanced_blocks),
    hasWarnings: Number(row.has_warnings),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    description: row.description ? String(row.description) : null,
    searchKeywords: row.search_keywords ? String(row.search_keywords) : null,
    customFields: customFieldsObj,
  };
}

/**
 * Catalog products for the filename-ownership snapshot (issue #106
 * SEQUENCE 2b). Returns raw custom fields + title per SKU; the snapshot
 * builder resolves the effective name (custom FileName wins, else the
 * workspace file derivation when a workspace path is supplied).
 */
export function listCatalogProductsForSnapshot(): Array<{
  sku: string;
  title: string;
  customFields: Record<string, unknown> | null;
}> {
  const db = getDb();
  const rows = db.query(
    `SELECT sku, title, custom_fields FROM product_index`,
  ).all() as Array<Record<string, unknown>>;
  const out: Array<{ sku: string; title: string; customFields: Record<string, unknown> | null }> = [];
  for (const row of rows) {
    const sku = String(row.sku ?? '');
    if (!sku) continue;
    let custom: Record<string, unknown> | null = null;
    try {
      custom = row.custom_fields ? JSON.parse(String(row.custom_fields)) as Record<string, unknown> : null;
    } catch {
      // custom stays null on unparseable JSON.
    }
    out.push({ sku, title: String(row.title ?? ''), customFields: custom });
  }
  return out;
}

/**
 * Catalog filename ownership for the promotion snapshot (issue #106
 * SEQUENCE 2b). Approved catalog products reserve their explicit custom
 * `FileName` (matching resolveBaseFileName precedence for indexed rows).
 * Rows without an explicit custom FileName reserve nothing here.
 *
 * Issue #106 C2 — intentional scope boundary (pinned by test): this
 * covers the DB-indexed catalog state only. The promotion ownership
 * snapshot additionally overlays workspace files (effective-product
 * resolution for healed seo-only names) because promotion runs with
 * workspace access and is the primary enforcer; pre-sync and drift
 * enforce on this indexed set. A healed seo-only catalog name is
 * promotion-owned but pre-sync/drift-invisible by design.
 */
export function listCatalogFilenameOwners(): Array<{ sku: string; fileName: string }> {
  const owners: Array<{ sku: string; fileName: string }> = [];
  for (const { sku, customFields } of listCatalogProductsForSnapshot()) {
    const raw = customFields?.['FileName'];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const trimmed = raw.trim();
    const name = /\.html$/i.test(trimmed) ? trimmed : `${trimmed}.html`;
    if (name.toLowerCase() === '.html') continue;
    owners.push({ sku, fileName: name });
  }
  return owners;
}
