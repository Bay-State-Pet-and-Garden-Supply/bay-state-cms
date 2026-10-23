import type { Database } from 'bun:sqlite';
import { AcceptedItemEvidenceSchema, type AcceptedItemEvidence } from '../../shared/schemas/item-evidence';
import { hashCanonicalJson } from '../../shared/stable-id';
import { getDb } from '../connection';

/** Install the append-only snapshot and CAS pointer tables; no historical rows are backfilled. */
export function installAcceptedItemEvidenceSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accepted_item_evidence_snapshots (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      input_hash TEXT NOT NULL,
      source_state_hash TEXT NOT NULL,
      authority_hash TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      UNIQUE (workspace_id, item_id, revision),
      UNIQUE (workspace_id, item_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_accepted_item_evidence_history
      ON accepted_item_evidence_snapshots(workspace_id, item_id, revision DESC);
    CREATE TABLE IF NOT EXISTS accepted_item_evidence_current (
      workspace_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, item_id),
      FOREIGN KEY (workspace_id, item_id, snapshot_id)
        REFERENCES accepted_item_evidence_snapshots(workspace_id, item_id, id)
    );
    CREATE TRIGGER IF NOT EXISTS accepted_item_evidence_snapshots_no_update
      BEFORE UPDATE ON accepted_item_evidence_snapshots
      BEGIN SELECT RAISE(ABORT, 'accepted item evidence snapshots are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS accepted_item_evidence_snapshots_no_delete
      BEFORE DELETE ON accepted_item_evidence_snapshots
      BEGIN SELECT RAISE(ABORT, 'accepted item evidence snapshots are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS accepted_item_evidence_current_no_delete
      BEFORE DELETE ON accepted_item_evidence_current
      BEGIN SELECT RAISE(ABORT, 'accepted item evidence current pointer cannot be removed'); END;
    CREATE TRIGGER IF NOT EXISTS accepted_item_evidence_current_insert_guard
      BEFORE INSERT ON accepted_item_evidence_current
      WHEN (NEW.revision != 1 AND NOT EXISTS (
        SELECT 1 FROM accepted_item_evidence_current c
        WHERE c.workspace_id = NEW.workspace_id AND c.item_id = NEW.item_id
      )) OR NOT EXISTS (
        SELECT 1 FROM accepted_item_evidence_snapshots s
        WHERE s.workspace_id = NEW.workspace_id AND s.item_id = NEW.item_id
          AND s.id = NEW.snapshot_id AND s.revision = NEW.revision
      )
      BEGIN SELECT RAISE(ABORT, 'accepted item evidence current pointer must reference the next snapshot'); END;
    CREATE TRIGGER IF NOT EXISTS accepted_item_evidence_current_advance_guard
      BEFORE UPDATE ON accepted_item_evidence_current
      WHEN NEW.revision != OLD.revision + 1 OR NOT EXISTS (
        SELECT 1 FROM accepted_item_evidence_snapshots s
        WHERE s.workspace_id = NEW.workspace_id AND s.item_id = NEW.item_id
          AND s.id = NEW.snapshot_id AND s.revision = NEW.revision
      )
      BEGIN SELECT RAISE(ABORT, 'accepted item evidence current pointer must advance to the next snapshot'); END;
  `);
}

export function acceptedItemEvidenceHash(evidence: AcceptedItemEvidence): string {
  const { evidenceHash: _evidenceHash, ...content } = evidence;
  return hashCanonicalJson(content);
}

function parseSnapshot(json: string, row: {
  id: string;
  workspace_id: string;
  batch_id: string;
  item_id: string;
  revision: number;
  input_hash: string;
  source_state_hash: string;
  authority_hash: string;
  evidence_hash: string;
}): AcceptedItemEvidence {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('Accepted item evidence snapshot contains invalid JSON');
  }
  const parsed = AcceptedItemEvidenceSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Accepted item evidence snapshot is invalid');
  const evidence = parsed.data;
  if (
    evidence.id !== row.id || evidence.workspaceId !== row.workspace_id || evidence.batchId !== row.batch_id ||
    evidence.itemId !== row.item_id || evidence.revision !== row.revision || evidence.inputHash !== row.input_hash ||
    evidence.sourceStateHash !== row.source_state_hash || evidence.authorityHash !== row.authority_hash ||
    evidence.evidenceHash !== row.evidence_hash || acceptedItemEvidenceHash(evidence) !== evidence.evidenceHash
  ) {
    throw new Error('Accepted item evidence snapshot binding or hash is invalid');
  }
  return evidence;
}

/** Current immutable snapshot for an item, scoped through its live batch owner. */
export function getCurrentItemEvidence(workspaceId: string, itemId: string): AcceptedItemEvidence | null {
  const row = getDb().query(`
    SELECT s.id, s.workspace_id, s.batch_id, s.item_id, s.revision, s.input_hash,
           s.source_state_hash, s.authority_hash, s.evidence_hash, s.snapshot_json
    FROM accepted_item_evidence_current c
    JOIN accepted_item_evidence_snapshots s
      ON s.workspace_id = c.workspace_id AND s.item_id = c.item_id
     AND s.id = c.snapshot_id AND s.revision = c.revision
    JOIN onboarding_items i ON i.id = s.item_id AND i.batch_id = s.batch_id
    JOIN onboarding_batches b ON b.id = i.batch_id AND b.workspace_id = s.workspace_id
    WHERE c.workspace_id = ? AND c.item_id = ?
  `).get(workspaceId, itemId) as ({ snapshot_json: string } & Parameters<typeof parseSnapshot>[1]) | undefined;
  return row ? parseSnapshot(row.snapshot_json, row) : null;
}

/** Immutable history lookup; a snapshot cannot be read through another workspace or item. */
export function getItemEvidenceSnapshot(
  workspaceId: string,
  itemId: string,
  snapshotId: string,
): AcceptedItemEvidence | null {
  const row = getDb().query(`
    SELECT s.id, s.workspace_id, s.batch_id, s.item_id, s.revision, s.input_hash,
           s.source_state_hash, s.authority_hash, s.evidence_hash, s.snapshot_json
    FROM accepted_item_evidence_snapshots s
    JOIN onboarding_items i ON i.id = s.item_id AND i.batch_id = s.batch_id
    JOIN onboarding_batches b ON b.id = i.batch_id AND b.workspace_id = s.workspace_id
    WHERE s.workspace_id = ? AND s.item_id = ? AND s.id = ?
  `).get(workspaceId, itemId, snapshotId) as ({ snapshot_json: string } & Parameters<typeof parseSnapshot>[1]) | undefined;
  return row ? parseSnapshot(row.snapshot_json, row) : null;
}
/** Complete immutable history for an item, scoped through its live workspace owner. */
export function listItemEvidenceSnapshots(workspaceId: string, itemId: string): AcceptedItemEvidence[] {
  const rows = getDb().query(`
    SELECT s.id, s.workspace_id, s.batch_id, s.item_id, s.revision, s.input_hash,
           s.source_state_hash, s.authority_hash, s.evidence_hash, s.snapshot_json
    FROM accepted_item_evidence_snapshots s
    JOIN onboarding_items i ON i.id = s.item_id AND i.batch_id = s.batch_id
    JOIN onboarding_batches b ON b.id = i.batch_id AND b.workspace_id = s.workspace_id
    WHERE s.workspace_id = ? AND s.item_id = ?
    ORDER BY s.revision ASC
  `).all(workspaceId, itemId) as Array<{ snapshot_json: string } & Parameters<typeof parseSnapshot>[1]>;
  return rows.map((row) => parseSnapshot(row.snapshot_json, row));
}

/**
 * Append one server-built snapshot and atomically advance the current pointer iff the
 * caller's expected revision still owns it. Returns false on a stale CAS without
 * leaving an orphan snapshot.
 */
export function appendAcceptedItemEvidenceSnapshot(input: {
  workspaceId: string;
  itemId: string;
  expectedRevision: number;
  evidence: AcceptedItemEvidence;
}): boolean {
  const parsed = AcceptedItemEvidenceSchema.safeParse(input.evidence);
  if (!parsed.success) throw new Error('Refusing invalid accepted item evidence snapshot');
  const evidence = parsed.data;
  if (
    !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 ||
    evidence.workspaceId !== input.workspaceId || evidence.itemId !== input.itemId ||
    evidence.revision !== input.expectedRevision + 1 || acceptedItemEvidenceHash(evidence) !== evidence.evidenceHash
  ) {
    throw new Error('Accepted item evidence snapshot does not match its CAS binding');
  }

  const db = getDb();
  let stale = false;
  try {
    db.transaction(() => {
      const owner = db.query(`
        SELECT i.batch_id, i.upc, b.workspace_id
        FROM onboarding_items i JOIN onboarding_batches b ON b.id = i.batch_id
        WHERE i.id = ?
      `).get(input.itemId) as { batch_id: string; upc: string; workspace_id: string } | undefined;
      if (!owner || owner.workspace_id !== input.workspaceId || owner.batch_id !== evidence.batchId || owner.upc !== evidence.sku) {
        throw new Error('Accepted item evidence snapshot is not bound to the current item owner and SKU');
      }

      const current = db.query(`
        SELECT revision FROM accepted_item_evidence_current WHERE workspace_id = ? AND item_id = ?
      `).get(input.workspaceId, input.itemId) as { revision: number } | undefined;
      if ((current?.revision ?? 0) !== input.expectedRevision) {
        stale = true;
        return;
      }

      db.query(`
        INSERT INTO accepted_item_evidence_snapshots
          (id, workspace_id, batch_id, item_id, revision, input_hash, source_state_hash,
           authority_hash, evidence_hash, snapshot_json, accepted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        evidence.id, evidence.workspaceId, evidence.batchId, evidence.itemId, evidence.revision,
        evidence.inputHash, evidence.sourceStateHash, evidence.authorityHash, evidence.evidenceHash,
        JSON.stringify(evidence), evidence.acceptedAt,
      );
      const changed = db.query(`
        INSERT INTO accepted_item_evidence_current (workspace_id, item_id, snapshot_id, revision, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, item_id) DO UPDATE SET
          snapshot_id = excluded.snapshot_id, revision = excluded.revision, updated_at = excluded.updated_at
        WHERE accepted_item_evidence_current.revision = ?
      `).run(
        input.workspaceId, input.itemId, evidence.id, evidence.revision, evidence.acceptedAt, input.expectedRevision,
      );
      if (changed.changes !== 1) {
        stale = true;
        throw new Error('accepted_item_evidence_cas_lost');
      }
    })();
  } catch (error) {
    if (error instanceof Error && error.message === 'accepted_item_evidence_cas_lost') return false;
    throw error;
  }
  return !stale;
}
