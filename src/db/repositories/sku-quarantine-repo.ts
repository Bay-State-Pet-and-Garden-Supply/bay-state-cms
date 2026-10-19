import { getDb } from '../connection';

export interface SkuQuarantineRow {
  workspaceId: string;
  sku: string;
  reason: string;
  detailsJson: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

function mapRow(row: Record<string, unknown>): SkuQuarantineRow {
  return {
    workspaceId: String(row.workspace_id),
    sku: String(row.sku),
    reason: String(row.reason),
    detailsJson: row.details_json ? String(row.details_json) : null,
    createdAt: String(row.created_at),
    resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
  };
}

function ensureQuarantineTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS sku_quarantine (
      workspace_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      reason TEXT NOT NULL,
      details_json TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      PRIMARY KEY (workspace_id, sku)
    );
    CREATE INDEX IF NOT EXISTS idx_sku_quarantine_active
      ON sku_quarantine(workspace_id, sku) WHERE resolved_at IS NULL;
  `);
}

/**
 * P0 #5 durable duplicate-SKU quarantine. A quarantined SKU is excluded from
 * candidate selection, approval, and import until the merchant resolves the
 * twin records separately (by merchant ID/GUID/name plus PDP evidence). Never
 * infer which twin `uniqueName=SKU` will mutate.
 */
export function quarantineSku(workspaceId: string, sku: string, reason: string, detailsJson?: string | null): SkuQuarantineRow {
  ensureQuarantineTable();
  const db = getDb();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO sku_quarantine (workspace_id, sku, reason, details_json, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT(workspace_id, sku) DO UPDATE SET
       reason = EXCLUDED.reason,
       details_json = EXCLUDED.details_json,
       resolved_at = NULL`,
    [workspaceId, sku, reason, detailsJson ?? null, now],
  );
  return findQuarantinedSku(workspaceId, sku)!;
}

export function findQuarantinedSku(workspaceId: string, sku: string): SkuQuarantineRow | null {
  ensureQuarantineTable();
  const row = getDb().query(
    'SELECT * FROM sku_quarantine WHERE workspace_id = ? AND sku = ?',
  ).get(workspaceId, sku) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

export function isSkuQuarantined(workspaceId: string, sku: string): boolean {
  const row = findQuarantinedSku(workspaceId, sku);
  return row !== null && row.resolvedAt === null;
}

export function listActiveQuarantinedSkus(workspaceId: string): SkuQuarantineRow[] {
  ensureQuarantineTable();
  const rows = getDb().query(
    'SELECT * FROM sku_quarantine WHERE workspace_id = ? AND resolved_at IS NULL ORDER BY sku ASC',
  ).all(workspaceId) as Record<string, unknown>[];
  return rows.map(mapRow);
}

export function resolveSkuQuarantine(workspaceId: string, sku: string): void {
  getDb().run(
    'UPDATE sku_quarantine SET resolved_at = ? WHERE workspace_id = ? AND sku = ?',
    [new Date().toISOString(), workspaceId, sku],
  );
}
