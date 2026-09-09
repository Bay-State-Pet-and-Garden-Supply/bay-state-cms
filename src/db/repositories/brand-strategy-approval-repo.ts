import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import {
  ApproveBrandStrategySchema,
  ApprovedBrandStrategySchema,
  type ApprovedBrandStrategy,
  type StrategySourceRef,
} from '../../shared/schemas/brand-strategy';

/** Normalize brand identity independently of domain mappings (exact authority). */
export function normalizeBrandKey(brand: string): string {
  return brand.toLowerCase().trim();
}

interface StrategyRow {
  id: string;
  workspace_id: string;
  brand: string;
  normalized_brand: string;
  sources_json: string;
  revision: number;
  approved: number;
  approved_at: string | null;
  approved_by: string | null;
  created_at: string;
  updated_at: string;
}

function parseSourcesJson(raw: string): StrategySourceRef[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StrategySourceRef[]) : [];
  } catch {
    return [];
  }
}

function mapRow(row: StrategyRow): ApprovedBrandStrategy {
  const safe = parseSourcesJson(row.sources_json);
  return ApprovedBrandStrategySchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    brand: row.brand,
    normalizedBrand: row.normalized_brand,
    sources: safe,
    revision: row.revision,
    approved: row.approved === 1,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function ensureTables(): void {
  // Defensive for minimal test DBs that run migrations selectively.
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS brand_sourcing_strategies (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, brand TEXT NOT NULL,
    normalized_brand TEXT NOT NULL, sources_json TEXT NOT NULL DEFAULT '[]',
    revision INTEGER NOT NULL DEFAULT 1, approved INTEGER NOT NULL DEFAULT 0,
    approved_at TEXT, approved_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(workspace_id, normalized_brand))`);
}

export function getApprovedBrandStrategy(workspaceId: string, brand: string | null): ApprovedBrandStrategy | null {
  if (!brand || !brand.trim()) return null;
  ensureTables();
  const db = getDb();
  const row = db.query(
    'SELECT * FROM brand_sourcing_strategies WHERE workspace_id = ? AND normalized_brand = ?',
  ).get(workspaceId, normalizeBrandKey(brand)) as StrategyRow | undefined;
  if (!row || row.approved !== 1) return null;
  return mapRow(row);
}

/** Latest stored strategy row regardless of approval (for proposal/read flows). */
export function getBrandStrategyRow(workspaceId: string, brand: string | null): ApprovedBrandStrategy | null {
  if (!brand || !brand.trim()) return null;
  ensureTables();
  const db = getDb();
  const row = db.query(
    'SELECT * FROM brand_sourcing_strategies WHERE workspace_id = ? AND normalized_brand = ?',
  ).get(workspaceId, normalizeBrandKey(brand)) as StrategyRow | undefined;
  return row ? mapRow(row) : null;
}

/**
 * Approve (or re-approve) a reusable brand strategy. Viewing or generating a
 * proposal never writes; only this explicit command persists approval.
 * Stale writes guarded by expectedRevision; repeat identical approvals are
 * idempotent (no revision bump when the source set is unchanged).
 */
export function approveBrandStrategy(
  workspaceId: string,
  input: { brand: string; sources: StrategySourceRef[]; expectedRevision?: number; approvedBy?: string },
): ApprovedBrandStrategy {
  const parsed = ApproveBrandStrategySchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid brand strategy approval: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  ensureTables();
  const db = getDb();
  const normalized = normalizeBrandKey(parsed.data.brand);
  const now = new Date().toISOString();
  const existing = db.query(
    'SELECT * FROM brand_sourcing_strategies WHERE workspace_id = ? AND normalized_brand = ?',
  ).get(workspaceId, normalized) as StrategyRow | undefined;

  if (parsed.data.expectedRevision !== undefined && existing && existing.revision !== parsed.data.expectedRevision) {
    const err = new Error(`stale_revision: expected ${parsed.data.expectedRevision}, stored ${existing.revision}`) as Error & { code: string };
    err.code = 'stale_revision';
    throw err;
  }

  const sourcesJson = JSON.stringify(parsed.data.sources);
  if (existing) {
    // Idempotent repeat approval: same sources → no bump, refresh attestation.
    if (existing.sources_json === sourcesJson && existing.approved === 1) {
      db.query('UPDATE brand_sourcing_strategies SET approved_at = ?, approved_by = ?, updated_at = ? WHERE id = ?')
        .run(now, parsed.data.approvedBy ?? existing.approved_by, now, existing.id);
      return getBrandStrategyRow(workspaceId, parsed.data.brand)!;
    }
    const nextRevision = existing.revision + 1;
    db.query(`UPDATE brand_sourcing_strategies SET brand = ?, sources_json = ?, revision = ?,
      approved = 1, approved_at = ?, approved_by = ?, updated_at = ? WHERE id = ?`)
      .run(parsed.data.brand.trim(), sourcesJson, nextRevision, now, parsed.data.approvedBy ?? null, now, existing.id);
    return getBrandStrategyRow(workspaceId, parsed.data.brand)!;
  }

  const id = `bss_${randomUUID().slice(0, 8)}`;
  try {
    db.query(`INSERT INTO brand_sourcing_strategies
      (id, workspace_id, brand, normalized_brand, sources_json, revision, approved, approved_at, approved_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`)
      .run(id, workspaceId, parsed.data.brand.trim(), normalized, sourcesJson, now, parsed.data.approvedBy ?? null, now, now);
  } catch (err) {
    // Concurrent first approvals race the SELECT above: surface the
    // UNIQUE(workspace_id, normalized_brand) violation as stale_revision
    // (fail-safe — the winner's row is untouched) instead of a 500.
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      const race = new Error(`stale_revision: brand strategy for '${parsed.data.brand}' was created concurrently`) as Error & { code: string };
      race.code = 'stale_revision';
      throw race;
    }
    throw err;
  }
  return getBrandStrategyRow(workspaceId, parsed.data.brand)!;
}

export function listApprovedBrandStrategies(workspaceId: string): ApprovedBrandStrategy[] {
  ensureTables();
  const db = getDb();
  const rows = db.query(
    'SELECT * FROM brand_sourcing_strategies WHERE workspace_id = ? AND approved = 1 ORDER BY brand ASC',
  ).all(workspaceId) as StrategyRow[];
  return rows.map(mapRow);
}
