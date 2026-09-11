import { getDb } from '../connection';
import { randomUUID, createHash } from 'node:crypto';
import { getRuleSeverity, type ValidationContext } from '../../validation/product-validation';

export interface PreparationGapInput {
  workspaceId: string;
  itemId: string;
  batchId: string;
  collectionResultVersion?: string;
  missingFields: string[];
  reason: string;
  evidenceHash?: string | null;
}

/** Merchandising fields an operator correction may supply (never identity, variant, provenance, or rights). */
export const CORRECTABLE_GAP_FIELDS = ['title', 'description'] as const;
export type CorrectableGapField = (typeof CORRECTABLE_GAP_FIELDS)[number];

/** Revisioned, attributed correction envelope (immutable once recorded; superseded by new revisions). */
export interface GapCorrectionEnvelope {
  revision: number;
  values: Record<string, string>;
  actor: string;
  role: string;
  recordedAt: string;
  /** Gap evidence binding the correction was accepted against (stale guard). */
  baseEvidenceHash: string | null;
  baseUpdatedAt: string;
  correctionHash: string;
  receiptId: string | null;
  /** Preparation run that consumed this correction (set at resume). */
  runId: string | null;
  status: 'recorded' | 'preparing' | 'applied' | 'failed' | 'superseded';
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
  /** Latest correction envelope (null when never corrected). */
  correctionEnvelope: GapCorrectionEnvelope | null;
  correctionRevision: number;
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
  correction_envelope_json: string | null;
  correction_revision: number | null;
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
  const envelope = parseJsonFallback<GapCorrectionEnvelope | null>(row.correction_envelope_json, null);
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
    correctionEnvelope: envelope && typeof envelope.revision === 'number' ? envelope : null,
    correctionRevision: typeof row.correction_revision === 'number' ? row.correction_revision : 0,
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
    correction_envelope_json TEXT, correction_revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(item_id))`);
  // Additive-only upgrade for pre-#124 databases (no CHECK touched, no rebuild).
  const cols = db.query('PRAGMA table_info(preparation_gaps)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'correction_envelope_json')) {
    db.exec('ALTER TABLE preparation_gaps ADD COLUMN correction_envelope_json TEXT;');
  }
  if (!cols.some((c) => c.name === 'correction_revision')) {
    db.exec('ALTER TABLE preparation_gaps ADD COLUMN correction_revision INTEGER NOT NULL DEFAULT 0;');
  }
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
    // Refresh preserves correction audit: a prior envelope whose values
    // still cover the new missing set is retained; otherwise it is marked
    // superseded in place (values kept for audit, never silently dropped).
    // A resolved gap reopens only through this refresh path with new work.
    // Ticket #124 P2-10: the legacy correction column is preserved
    // alongside the envelope while still covered (legacy readers must not
    // see data vanish on refresh).
    let envelopeJson: string | null = existing.correction_envelope_json;
    let correctionJson: string | null = existing.correction_json;
    try {
      const prior = envelopeJson ? (JSON.parse(envelopeJson) as Partial<GapCorrectionEnvelope>) : null;
      if (prior && typeof prior === 'object') {
        const priorValues = (prior.values ?? {}) as Record<string, unknown>;
        const stillCovered = missing.every((f) => typeof priorValues[f] === 'string' && (priorValues[f] as string).trim().length > 0);
        if (!stillCovered && prior.status !== 'applied') {
          envelopeJson = JSON.stringify({ ...prior, status: 'superseded' });
          correctionJson = null;
        }
      }
    } catch {
      // Corrupt envelope JSON never blocks a refresh; it is replaced below
      // only when a new correction is recorded.
    }
    db.query(`UPDATE preparation_gaps SET workspace_id = ?, batch_id = ?,
      collection_result_version = ?, missing_fields_json = ?, reason = ?, evidence_hash = ?,
      status = 'open', opened_at = ?, resolved_at = NULL, resolved_by = NULL, correction_json = ?,
      correction_envelope_json = ?, updated_at = ? WHERE item_id = ?`)
      .run(input.workspaceId, input.batchId, input.collectionResultVersion ?? 'strategy-collection-v1',
        JSON.stringify(missing), reason, input.evidenceHash ?? null, existing.opened_at, correctionJson, envelopeJson, now, input.itemId);
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
 * Ticket #124: required preparation fields derived from EXISTING blocking
 * validation requirements — never a new universal checklist. Title tracks
 * MISSING_NAME (blocker by default); description tracks MISSING_DESCRIPTION
 * (warning by default, gap only when the store configures it blocking).
 * An optional store rules config overrides severities per the shared
 * validation framework.
 */
export function blockingPreparationFields(
  rulesConfig?: Record<string, 'blocker' | 'warning' | 'info' | 'disabled'>,
): string[] {
  const context = {
    workspaceId: '',
    scopeType: 'catalog',
    scopeId: '',
    allSkus: [],
    rulesConfig,
  } as ValidationContext;
  const fields: string[] = [];
  if (getRuleSeverity('MISSING_NAME', 'blocker', context) === 'blocker') fields.push('title');
  if (getRuleSeverity('MISSING_DESCRIPTION', 'warning', context) === 'blocker') fields.push('description');
  return fields;
}

/** Canonical hash over a correction command (scope + binding + values + actor). */
export function computeCorrectionHash(input: {
  itemId: string;
  batchId: string;
  revision: number;
  values: Record<string, string>;
  baseEvidenceHash: string | null;
  baseUpdatedAt: string;
  actor: string;
}): string {
  const canonical = JSON.stringify({
    domain: 'gap-correction-v1',
    itemId: input.itemId,
    batchId: input.batchId,
    revision: input.revision,
    values: Object.fromEntries(Object.entries(input.values).sort(([a], [b]) => (a < b ? -1 : 1))),
    baseEvidenceHash: input.baseEvidenceHash,
    baseUpdatedAt: input.baseUpdatedAt,
    actor: input.actor,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function codedGapError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function boundValues(values: Record<string, unknown>): Record<string, string> {
  const bounded: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === 'string' && v.trim()) bounded[k.slice(0, 64)] = v.slice(0, 2000);
  }
  return bounded;
}

/**
 * Record an operator correction against an OPEN gap (ticket #124).
 * Validation, not resolution: the gap stays open until re-preparation
 * succeeds. Stale callers (superseded evidence binding or gap revision)
 * fail closed; forbidden fields (anything outside the gap's missing
 * correctable fields) are rejected — identity, variant, provenance, and
 * rights can never change through the merchandising-gap path.
 */
export function recordGapCorrection(input: {
  itemId: string;
  values: Record<string, unknown>;
  actor: string;
  role: string;
  expectedEvidenceHash?: string | null;
  expectedUpdatedAt?: string | null;
  receiptId?: string | null;
}): { gap: PreparationGap; envelope: GapCorrectionEnvelope } {
  ensureTable();
  const gap = getPreparationGap(input.itemId);
  if (!gap) throw codedGapError('no_gap', 'No preparation gap for item');
  if (gap.status !== 'open') throw codedGapError('gap_not_open', 'Preparation gap is not open');
  if (input.expectedEvidenceHash !== undefined && (gap.evidenceHash ?? null) !== (input.expectedEvidenceHash ?? null)) {
    throw codedGapError('stale_gap', 'Gap evidence binding changed since read; reload and retry');
  }
  if (input.expectedUpdatedAt !== undefined && gap.updatedAt !== input.expectedUpdatedAt) {
    throw codedGapError('stale_gap', 'Gap changed since read; reload and retry');
  }
  if (!input.actor.trim()) throw codedGapError('invalid_actor', 'Correction actor is required');
  const allowed = new Set(gap.missingFields.filter((f) => (CORRECTABLE_GAP_FIELDS as readonly string[]).includes(f)));
  const values = boundValues(input.values);
  const forbidden = Object.keys(values).filter((k) => !allowed.has(k));
  if (forbidden.length > 0) {
    throw codedGapError('invalid_field', `Correction fields not correctable through this gap: ${forbidden.join(', ')}`);
  }
  const unmet = [...allowed].filter((f) => !values[f]);
  if (unmet.length > 0) {
    throw codedGapError('correction_incomplete', `Correction is missing values for: ${unmet.join(', ')}`);
  }
  const db = getDb();
  const now = new Date().toISOString();
  const revision = gap.correctionRevision + 1;
  const envelope: GapCorrectionEnvelope = {
    revision,
    values,
    actor: input.actor.trim(),
    role: input.role,
    recordedAt: now,
    baseEvidenceHash: gap.evidenceHash ?? null,
    baseUpdatedAt: gap.updatedAt,
    correctionHash: '',
    receiptId: input.receiptId ?? null,
    runId: null,
    status: 'recorded',
  };
  envelope.correctionHash = computeCorrectionHash({
    itemId: gap.itemId,
    batchId: gap.batchId,
    revision,
    values,
    baseEvidenceHash: envelope.baseEvidenceHash,
    baseUpdatedAt: envelope.baseUpdatedAt,
    actor: envelope.actor,
  });
  db.query(`UPDATE preparation_gaps SET correction_envelope_json = ?, correction_revision = ?,
    correction_json = ?, updated_at = ? WHERE item_id = ? AND status = 'open'`)
    .run(JSON.stringify(envelope), revision, JSON.stringify(values), now, input.itemId);
  const updated = getPreparationGap(input.itemId)!;
  return { gap: updated, envelope: updated.correctionEnvelope! };
}

/** Mark a recorded correction as consumed by a preparation run (or failed). */
export function markCorrectionRun(input: {
  itemId: string;
  revision: number;
  runId: string | null;
  status: 'preparing' | 'failed';
}): PreparationGap {
  ensureTable();
  const db = getDb();
  const gap = getPreparationGap(input.itemId);
  if (!gap?.correctionEnvelope || gap.correctionEnvelope.revision !== input.revision) {
    throw codedGapError('stale_gap', 'Correction revision changed since read');
  }
  const envelope: GapCorrectionEnvelope = {
    ...gap.correctionEnvelope,
    runId: input.runId,
    status: input.status,
  };
  db.query('UPDATE preparation_gaps SET correction_envelope_json = ?, updated_at = ? WHERE item_id = ?')
    .run(JSON.stringify(envelope), new Date().toISOString(), input.itemId);
  return getPreparationGap(input.itemId)!;
}

/**
 * Resolve a gap ONLY after successful preparation validation against the
 * same revision, correction hash, and evidence binding. A stale worker
 * (newer gap revision, re-finalized evidence, mismatched run) can never
 * clear a newer gap. Commit the validated output and this resolution
 * together — callers own the transaction pairing.
 */
export function resolveAfterValidation(input: {
  itemId: string;
  revision: number;
  correctionHash: string;
  evidenceHash: string | null;
  resolvedBy: string;
}): PreparationGap {
  ensureTable();
  const db = getDb();
  const gap = getPreparationGap(input.itemId);
  if (!gap) throw codedGapError('no_gap', 'No preparation gap for item');
  if (gap.status !== 'open') throw codedGapError('gap_not_open', 'Preparation gap is not open');
  // Sufficient on retained evidence alone (no correction envelope): the
  // caller just validated successfully (e.g. explicit recollection fixed
  // the insufficiency). Revision 0 + empty hash address no envelope.
  if (input.revision === 0 && input.correctionHash === '') {
    if (gap.correctionEnvelope && gap.correctionEnvelope.status !== 'superseded' && gap.correctionEnvelope.status !== 'failed') {
      throw codedGapError('stale_gap', 'A correction is still being prepared for this gap');
    }
    if ((gap.evidenceHash ?? null) !== (input.evidenceHash ?? null)) {
      throw codedGapError('stale_gap', 'Gap evidence binding changed since validation ran');
    }
    if (!input.resolvedBy.trim()) throw codedGapError('invalid_actor', 'resolvedBy is required');
    const clearedAt = new Date().toISOString();
    db.query(`UPDATE preparation_gaps SET status = 'resolved', resolved_at = ?, resolved_by = ?,
      updated_at = ? WHERE item_id = ? AND status = 'open'`)
      .run(clearedAt, input.resolvedBy.trim(), clearedAt, input.itemId);
    return getPreparationGap(input.itemId)!;
  }
  const envelope = gap.correctionEnvelope;
  if (!envelope || envelope.revision !== input.revision || envelope.correctionHash !== input.correctionHash) {
    throw codedGapError('stale_gap', 'Correction changed since validation ran');
  }
  if ((gap.evidenceHash ?? null) !== (input.evidenceHash ?? null)) {
    throw codedGapError('stale_gap', 'Gap evidence binding changed since validation ran');
  }
  if (!input.resolvedBy.trim()) throw codedGapError('invalid_actor', 'resolvedBy is required');
  const now = new Date().toISOString();
  const applied: GapCorrectionEnvelope = { ...envelope, status: 'applied' };
  db.query(`UPDATE preparation_gaps SET status = 'resolved', resolved_at = ?, resolved_by = ?,
    correction_json = ?, correction_envelope_json = ?, updated_at = ?
    WHERE item_id = ? AND status = 'open'`)
    .run(now, input.resolvedBy.trim(), JSON.stringify(envelope.values), JSON.stringify(applied), now, input.itemId);
  return getPreparationGap(input.itemId)!;
}

/** Bulk-load open gaps for a batch (the migration index exists for this). */
export function listGapsByBatch(batchId: string): PreparationGap[] {
  ensureTable();
  const db = getDb();
  const rows = db.query('SELECT * FROM preparation_gaps WHERE batch_id = ? AND status = \'open\' ORDER BY item_id ASC')
    .all(batchId) as GapRow[];
  return rows.map(mapRow);
}

/** Bulk-load open gaps for an item set (read-projection join; unknown items simply absent). */
export function listOpenGapsByItemIds(itemIds: string[]): PreparationGap[] {
  ensureTable();
  if (itemIds.length === 0) return [];
  const db = getDb();
  const placeholders = itemIds.map(() => '?').join(', ');
  const rows = db.query(
    `SELECT * FROM preparation_gaps WHERE item_id IN (${placeholders}) AND status = 'open'`,
  ).all(...itemIds) as GapRow[];
  return rows.map(mapRow);
}
