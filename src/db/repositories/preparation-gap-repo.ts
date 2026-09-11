import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';

export interface PreparationGapInput {
  workspaceId: string;
  itemId: string;
  batchId: string;
  collectionResultVersion?: string;
  missingFields: string[];
  reason: string;
  evidenceHash?: string | null;
}

export interface PreparationGap {
  id: string;
  workspaceId: string;
  itemId: string;
  batchId: string;
  collectionResultVersion: string;
  missingFields: string[];
  reason: string;
  evidenceHash: string | null;
  status: 'open' | 'resolved';
  openedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  correction: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
}

interface GapRow {
  id: string;
  workspace_id: string;
  item_id: string;
  batch_id: string;
  collection_result_version: string;
  missing_fields_json: string;
  reason: string;
  evidence_hash: string | null;
  status: string;
  opened_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  correction_json: string | null;
  created_at: string;
  updated_at: string;
}

const BOUND = 160;

function safeReason(reason: string): string {
  const trimmed = reason.trim().slice(0, BOUND);
  if (!trimmed) throw new Error('Preparation gap reason is required');
  return trimmed;
}

function parseJsonFallback<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapRow(row: GapRow): PreparationGap {
  const missing: unknown = parseJsonFallback<unknown>(row.missing_fields_json, []);
  const correction = parseJsonFallback<Record<string, string> | null>(row.correction_json, null);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    itemId: row.item_id,
    batchId: row.batch_id,
    collectionResultVersion: row.collection_result_version,
    missingFields: Array.isArray(missing) ? missing.filter((v): v is string => typeof v === 'string') : [],
    reason: row.reason,
    evidenceHash: row.evidence_hash,
    status: row.status === 'resolved' ? 'resolved' : 'open',
    openedAt: row.opened_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    correction,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ensureTable(): void {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS preparation_gaps (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, item_id TEXT NOT NULL, batch_id TEXT NOT NULL,
    collection_result_version TEXT NOT NULL DEFAULT 'strategy-collection-v1',
    missing_fields_json TEXT NOT NULL DEFAULT '[]', reason TEXT NOT NULL DEFAULT '',
    evidence_hash TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    opened_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT, correction_json TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(item_id))`);
}

/**
 * Assess post-consolidation insufficiency. The caller supplies the required
 * fields from existing listing/semantic validation contracts — this module
 * introduces no universal checklist and no per-source completeness gate.
 * Optional omissions never open a gap. Pure.
 */
export function assessListingEvidenceGap(input: {
  consolidatedFields: Record<string, string | null | undefined>;
  requiredFields: string[];
}): { missing: string[] } {
  const missing: string[] = [];
  for (const field of input.requiredFields) {
    const value = input.consolidatedFields[field];
    if (typeof value !== 'string' || value.trim().length === 0) missing.push(field);
  }
  return { missing: [...new Set(missing)].sort() };
}

/**
 * Open (or refresh) a durable gap. Idempotent per item: an existing open gap
 * for the same missing set, reason, AND collection hash is returned
 * unchanged; a changed set, reason, or hash updates the row without losing
 * the open state. Ticket #122: the hash participates in idempotency so a
 * re-finalized collection never leaves a stale hash behind.
 */
export function openPreparationGap(input: PreparationGapInput): PreparationGap {
  if (input.missingFields.length === 0) throw new Error('Cannot open a gap with no missing fields');
  ensureTable();
  const db = getDb();
  const now = new Date().toISOString();
  const missing = [...new Set(input.missingFields.map((f) => f.trim()).filter(Boolean))].sort();
  const reason = safeReason(input.reason);
  const evidenceHash = input.evidenceHash ?? null;
  const existing = db.query('SELECT * FROM preparation_gaps WHERE item_id = ?').get(input.itemId) as GapRow | undefined;
  if (existing && existing.status === 'open'
    && existing.missing_fields_json === JSON.stringify(missing)
    && existing.reason === reason
    && (existing.evidence_hash ?? null) === evidenceHash) {
    return mapRow(existing);
  }
  if (existing) {
    db.query(`UPDATE preparation_gaps SET workspace_id = ?, batch_id = ?,
      collection_result_version = ?, missing_fields_json = ?, reason = ?, evidence_hash = ?,
      status = 'open', opened_at = ?, resolved_at = NULL, resolved_by = NULL, correction_json = NULL,
      updated_at = ? WHERE item_id = ?`)
      .run(input.workspaceId, input.batchId, input.collectionResultVersion ?? 'strategy-collection-v1',
        JSON.stringify(missing), reason, input.evidenceHash ?? null, existing.opened_at, now, input.itemId);
    return getPreparationGap(input.itemId)!;
  }
  const id = `pgap_${randomUUID().slice(0, 8)}`;
  db.query(`INSERT INTO preparation_gaps
    (id, workspace_id, item_id, batch_id, collection_result_version, missing_fields_json, reason,
     evidence_hash, status, opened_at, resolved_at, resolved_by, correction_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL, NULL, NULL, ?, ?)`)
    .run(id, input.workspaceId, input.itemId, input.batchId,
      input.collectionResultVersion ?? 'strategy-collection-v1',
      JSON.stringify(missing), reason, input.evidenceHash ?? null, now, now, now);
  return getPreparationGap(input.itemId)!;
}

export function getPreparationGap(itemId: string): PreparationGap | null {
  ensureTable();
  const db = getDb();
  const row = db.query('SELECT * FROM preparation_gaps WHERE item_id = ?').get(itemId) as GapRow | undefined;
  return row ? mapRow(row) : null;
}

/** True only for an OPEN gap — resolved rows never block. Survives restarts (durable). */
export function hasUnresolvedPreparationGap(itemId: string): boolean {
  const gap = getPreparationGap(itemId);
  return gap !== null && gap.status === 'open';
}

/**
 * Resolve a gap with operator-supplied correction. The correction is
 * attributed to the operator (never merged into source evidence here) and
 * must supply a nonblank value for every missing field — otherwise the gap
 * stays open with its actionable reason. Idempotent: resolving an already
 * resolved gap returns it unchanged.
 */
export function resolvePreparationGap(input: {
  itemId: string;
  correction: Record<string, string>;
  resolvedBy: string;
}): PreparationGap {
  ensureTable();
  const db = getDb();
  const gap = getPreparationGap(input.itemId);
  if (!gap) throw new Error('No preparation gap for item');
  if (gap.status === 'resolved') return gap;
  const unmet = gap.missingFields.filter((f) => {
    const v = input.correction[f];
    return typeof v !== 'string' || v.trim().length === 0;
  });
  if (unmet.length > 0) {
    const err = new Error(`Correction is missing values for: ${unmet.join(', ')}`) as Error & { code: string };
    err.code = 'correction_incomplete';
    throw err;
  }
  if (!input.resolvedBy.trim()) throw new Error('resolvedBy is required');
  const now = new Date().toISOString();
  // Bounded operator values (no source-evidence rewrite happens here).
  const bounded: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.correction)) {
    if (typeof v === 'string' && v.trim()) bounded[k.slice(0, 64)] = v.slice(0, 2000);
  }
  db.query(`UPDATE preparation_gaps SET status = 'resolved', resolved_at = ?, resolved_by = ?,
    correction_json = ?, updated_at = ? WHERE item_id = ?`)
    .run(now, input.resolvedBy.trim(), JSON.stringify(bounded), now, input.itemId);
  return getPreparationGap(input.itemId)!;
}
