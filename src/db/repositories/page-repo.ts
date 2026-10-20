import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';

export interface PageRow {
  id: string;
  name: string;
  fileName: string | null;
  parentId: string | null;
  pageHash: string;
  workspaceId: string | null;
  importId: string | null;
  identityKind: 'exported_guid' | 'exported_file_name' | 'unverified_name_only' | string;
  identityKey: string | null;
  identityStatus: 'verified' | 'unverified' | string;
  sourceHash: string | null;
  availability: 'available' | 'unavailable' | string;
  reviewStatus: string;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function listPages(): PageRow[] {
  const db = getDb();
  const rows = db.query('SELECT * FROM page_index ORDER BY name ASC').all() as Record<string, any>[];
  return rows.map(mapPageRow);
}

// fallow-ignore-next-line unused-export
export function getPageByName(name: string): PageRow | null {
  const db = getDb();
  const row = db.query('SELECT * FROM page_index WHERE name = ? ORDER BY rowid ASC LIMIT 1').get(name) as Record<string, any> | undefined;
  return row ? mapPageRow(row) : null;
}

/**
 * Authoritative Page options: only rows whose identity is verified by the
 * currently ACTIVE page import and whose availability is `available`.
 * Name-only and out-of-import rows are review context and never appear here.
 */
export function listVerifiedPageOptions(workspaceId: string): PageRow[] {
  const db = getDb();
  const rows = db.query(
    `SELECT p.* FROM page_index p
     JOIN page_imports i ON i.id = p.import_id
     WHERE p.workspace_id = ? AND i.status = 'active'
       AND p.identity_status = 'verified' AND p.availability = 'available'
     ORDER BY p.name ASC`,
  ).all(workspaceId) as Record<string, any>[];
  return rows.map(mapPageRow);
}

/**
 * Source hash of the workspace's ACTIVE page import (e09 round-3 FIX 1).
 * The review completion gate compares a reviewer Category Page correction's
 * recorded hash against THIS value — a correction captured under a previous
 * import is stale and fails closed. Returns null when no active import exists.
 */
export function getActivePageImportHash(workspaceId: string): string | null {
  const db = getDb();
  const row = db.query(
    `SELECT source_hash FROM page_imports
     WHERE workspace_id = ? AND status = 'active'
     ORDER BY created_at DESC LIMIT 1`,
  ).get(workspaceId) as { source_hash: string } | undefined;
  return row?.source_hash ?? null;
}

/**
 * Provisional candidates from scanned ProductOnPages fragments. Review
 * context only — never verified identities. Delegates to the deterministic
 * fragment scanner over the workspace product files.
 */
export async function listProvisionalCandidates(workspacePath: string): Promise<import('../../shopsite/page-candidate-importer').ProvisionalCandidateScan> {
  const { scanProductOnPagesFromWorkspace } = await import('../../shopsite/page-candidate-importer');
  return scanProductOnPagesFromWorkspace(workspacePath);
}

export function upsertPage(
  page: Omit<
    PageRow,
    'id' | 'createdAt' | 'updatedAt' | 'workspaceId' | 'importId' | 'identityKind' |
      'identityKey' | 'identityStatus' | 'sourceHash' | 'availability' | 'reviewStatus'
  > & {
    id?: string;
    workspaceId?: string | null;
    importId?: string | null;
    identityKind?: string;
    identityKey?: string | null;
    identityStatus?: string;
    sourceHash?: string | null;
    availability?: string;
    reviewStatus?: string;
  },
): PageRow {
  const db = getDb();
  const id = page.id ?? randomUUID();
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO page_index (
       id, name, file_name, parent_id, page_hash, workspace_id, import_id,
       identity_kind, identity_key, identity_status, source_hash, availability,
       review_status, last_synced_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = EXCLUDED.name,
       file_name = EXCLUDED.file_name,
       parent_id = EXCLUDED.parent_id,
       page_hash = EXCLUDED.page_hash,
       workspace_id = EXCLUDED.workspace_id,
       import_id = EXCLUDED.import_id,
       identity_kind = EXCLUDED.identity_kind,
       identity_key = EXCLUDED.identity_key,
       identity_status = EXCLUDED.identity_status,
       source_hash = EXCLUDED.source_hash,
       availability = EXCLUDED.availability,
       review_status = EXCLUDED.review_status,
       last_synced_at = COALESCE(EXCLUDED.last_synced_at, page_index.last_synced_at),
       updated_at = EXCLUDED.updated_at`,
    [
      id, page.name, page.fileName ?? null, page.parentId ?? null, page.pageHash,
      page.workspaceId ?? null, page.importId ?? null,
      page.identityKind ?? 'unverified_name_only', page.identityKey ?? null,
      page.identityStatus ?? 'unverified', page.sourceHash ?? null,
      page.availability ?? 'unavailable', page.reviewStatus ?? 'pending',
      page.lastSyncedAt ?? null, now, now,
    ],
  );

  return {
    id,
    name: page.name,
    fileName: page.fileName ?? null,
    parentId: page.parentId ?? null,
    pageHash: page.pageHash,
    workspaceId: page.workspaceId ?? null,
    importId: page.importId ?? null,
    identityKind: page.identityKind ?? 'unverified_name_only',
    identityKey: page.identityKey ?? null,
    identityStatus: page.identityStatus ?? 'unverified',
    sourceHash: page.sourceHash ?? null,
    availability: page.availability ?? 'unavailable',
    reviewStatus: page.reviewStatus ?? 'pending',
    lastSyncedAt: page.lastSyncedAt ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

// ─── Product-Page Assignments ────────────────────────────────────────────────

/**
 * Assign a product to a verified page using stable page identity.
 * The caller MUST pass a pageId from the active verified import.
 */
export function assignProductToVerifiedPage(productSku: string, pageId: string, pageName: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.run(
    'INSERT OR IGNORE INTO product_pages (product_sku, page_name, page_id, created_at) VALUES (?, ?, ?, ?)',
    [productSku, pageName, pageId, now],
  );
}

/**
 * Remove one reviewed product-page assignment by its verified identity.
 * The caller MUST pass the Page identity from the active verified import.
 */
export function removeProductFromVerifiedPage(productSku: string, pageId: string, pageName: string): void {
  const db = getDb();
  db.run(
    'DELETE FROM product_pages WHERE product_sku = ? AND (page_id = ? OR page_name = ?)',
    [productSku, pageId, pageName],
  );
}

/**
 * Legacy name-based assignment (backward-compatible wrapper). Resolves the
 * page by name and writes page_id ONLY when that row carries a verified
 * identity from an active import; otherwise the assignment stays name-only
 * (review context, never a live identity reference).
 */
export function assignProductToPage(productSku: string, pageName: string): void {
  const page = getPageByName(pageName);
  if (page && page.identityStatus === 'verified' && page.availability === 'available') {
    assignProductToVerifiedPage(productSku, page.id, pageName);
  } else {
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      'INSERT OR IGNORE INTO product_pages (product_sku, page_name, created_at) VALUES (?, ?, ?)',
      [productSku, pageName, now],
    );
  }
}

/**
 * Legacy direct pageId assignment. Kept for backward compatibility with
 * verified-only callers; callers must supply a verified pageId from the
 * active import (see assignProductToVerifiedPage).
 */
export function assignProductToPageId(productSku: string, pageId: string, pageName: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.run(
    'INSERT OR IGNORE INTO product_pages (product_sku, page_name, page_id, created_at) VALUES (?, ?, ?, ?)',
    [productSku, pageName, pageId, now],
  );
}

// fallow-ignore-next-line unused-export
export function getProductPages(productSku: string): string[] {
  const db = getDb();
  const rows = db.query('SELECT page_name FROM product_pages WHERE product_sku = ?').all(productSku) as Array<{ page_name: string }>;
  return rows.map(r => r.page_name);
}

/**
 * Get product page assignments including both page ID and page name.
 */
export function getProductPageAssignments(productSku: string): Array<{ pageId: string | null; pageName: string }> {
  const db = getDb();
  const rows = db.query('SELECT page_id, page_name FROM product_pages WHERE product_sku = ?').all(productSku) as Array<{ page_id: string | null; page_name: string }>;
  return rows.map(r => ({ pageId: r.page_id ? String(r.page_id) : null, pageName: String(r.page_name) }));
}
/**
 * Owned-write restore (issue #363): replace one SKU's page joins with the
 * exact snapshot taken before approval. Callers snapshot via
 * `getProductPageAssignments` and restore here — no direct
 * `product_pages` SQL outside this repository.
 */
export function restoreProductPageJoins(
  productSku: string,
  joins: Array<{ pageId: string | null; pageName: string }>,
): void {
  const db = getDb();
  db.transaction(() => {
    db.run('DELETE FROM product_pages WHERE product_sku = ?', [productSku]);
    for (const join of joins) {
      if (join.pageId) {
        db.run(
          'INSERT OR IGNORE INTO product_pages (product_sku, page_name, page_id, created_at) VALUES (?, ?, ?, ?)',
          [productSku, join.pageName, join.pageId, new Date().toISOString()],
        );
      } else {
        db.run(
          'INSERT OR IGNORE INTO product_pages (product_sku, page_name, created_at) VALUES (?, ?, ?)',
          [productSku, join.pageName, new Date().toISOString()],
        );
      }
    }
  });
}

/**
 * Distinct assigned page names across ALL products — the catalog-wide name
 * list behind the legacy hard-coded page-name suggestion fallback in
 * product-curator (packaging-ocr overhaul P2-T5 repository cleanup of the
 * inline `SELECT DISTINCT page_name FROM product_pages` query).
 */
export function listDistinctProductPageNames(): string[] {
  const db = getDb();
  const rows = db.query('SELECT DISTINCT page_name FROM product_pages').all() as Array<{ page_name: string }>;
  return rows.map(r => r.page_name);
}

export function clearProductPages(productSku: string): void {
  const db = getDb();
  db.run('DELETE FROM product_pages WHERE product_sku = ?', [productSku]);
}

/**
 * Replace a SKU's page joins with verified identities only (P2 #23).
 *
 * Every name must resolve to exactly one verified + available row in the
 * active import; ambiguous or unverified names throw WITHOUT touching rows
 * (validate all, then clear + insert). Returns the resolved assignments.
 */
export function replaceProductPageJoins(
  productSku: string,
  pageNames: string[],
): Array<{ pageId: string; pageName: string }> {
  const resolved = pageNames.map(name => {
    const db = getDb();
    const rows = db.query(
      `SELECT p.* FROM page_index p
       JOIN page_imports i ON i.id = p.import_id
       WHERE p.name = ? AND i.status = 'active'
         AND p.identity_status = 'verified' AND p.availability = 'available'`,
    ).all(name) as Record<string, unknown>[];
    if (rows.length !== 1) {
      throw new Error(
        `Page "${name}" has no verified identity in the active import ` +
        `(${rows.length} verified rows); refusing to join.`,
      );
    }
    return mapPageRow(rows[0]);
  });
  clearProductPages(productSku);
  for (const page of resolved) {
    assignProductToVerifiedPage(productSku, page.id, page.name);
  }
  return resolved.map(page => ({ pageId: page.id, pageName: page.name }));
}

/**
 * Decode common XML entities in a string (e.g. "&amp;" -> "&").
 */
function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Extract page names from a product's preserved ProductOnPages blocks
 * and index them into the product_pages join table.
 *
 * page_id is written ONLY when the resolved row has a verified identity from
 * an active import; name-only rows stay name-only (review context).
 */
export function indexProductPageAssignments(product: { shopsite?: { preserved?: { unknownElements?: Record<string, unknown>; advancedBlocks?: Record<string, string> } }; sku: string }): void {
  const names = new Set<string>();
  const preserved = product.shopsite?.preserved;
  if (!preserved) return;

  const tagRegex = /<(?:Name|PageName|PageLink)>([^<]*)<\/(?:Name|PageName|PageLink)>/gi;

  // 1. Check unknownElements (set by draft-promoter)
  const fromUnknown = preserved.unknownElements?.['ProductOnPages'];
  if (fromUnknown) {
    const raw = String(fromUnknown);
    let m: RegExpExecArray | null;
    while ((m = tagRegex.exec(raw)) !== null) {
      const name = decodeXmlEntities(m[1].trim());
      if (name) names.add(name);
    }
  }

  // 2. Check advancedBlocks (from original ShopSite import or promotion)
  const fromAdvanced = preserved.advancedBlocks?.['ProductOnPages'] ?? preserved.advancedBlocks?.['productOnPages'];
  if (fromAdvanced) {
    let m: RegExpExecArray | null;
    while ((m = tagRegex.exec(fromAdvanced)) !== null) {
      const name = decodeXmlEntities(m[1].trim());
      if (name) names.add(name);
    }
  }

  if (names.size === 0) return;

  const db = getDb();
  const now = new Date().toISOString();

  // Clear existing assignments for this SKU and insert fresh
  db.run('DELETE FROM product_pages WHERE product_sku = ?', [product.sku]);

  for (const pageName of names) {
    // Resolve page id only when a verified identity exists.
    const page = getPageByName(pageName);
    if (page && page.identityStatus === 'verified' && page.availability === 'available') {
      db.run(
        'INSERT OR IGNORE INTO product_pages (product_sku, page_name, page_id, created_at) VALUES (?, ?, ?, ?)',
        [product.sku, pageName, page.id, now],
      );
    } else {
      db.run(
        'INSERT OR IGNORE INTO product_pages (product_sku, page_name, created_at) VALUES (?, ?, ?)',
        [product.sku, pageName, now],
      );
    }
  }
}

function mapPageRow(row: Record<string, any>): PageRow {
  return {
    id: String(row.id),
    name: String(row.name),
    fileName: row.file_name ? String(row.file_name) : null,
    parentId: row.parent_id ? String(row.parent_id) : null,
    pageHash: String(row.page_hash),
    workspaceId: row.workspace_id ? String(row.workspace_id) : null,
    importId: row.import_id ? String(row.import_id) : null,
    identityKind: row.identity_kind ? String(row.identity_kind) : 'unverified_name_only',
    identityKey: row.identity_key ? String(row.identity_key) : null,
    identityStatus: row.identity_status ? String(row.identity_status) : 'unverified',
    sourceHash: row.source_hash ? String(row.source_hash) : null,
    availability: row.availability ? String(row.availability) : 'unavailable',
    reviewStatus: row.review_status ? String(row.review_status) : 'pending',
    lastSyncedAt: row.last_synced_at ? String(row.last_synced_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
