import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import {
  OnboardingEvidenceConflictSchema,
  OnboardingEvidenceConflictCandidateSchema,
  type OnboardingEvidenceConflict,
  type OnboardingEvidenceConflictCandidate,
  type ConflictSeverity,
  type ConflictStatus,
  type ResolveConflictRequest,
} from '../../shared/schemas/distributor';
import { recordAcceptances } from './onboarding-acceptance-repo';
import { stagePredicateParams } from './onboarding-stage-vocabulary-repo';
import { completeSourcingViaProjection } from './onboarding-item-repo';
import type { ProjectionResolutionInput } from '../../onboarding/sourcing/distributor-record-projection';

interface ConflictRow {
  id: string;
  item_id: string;
  field: string;
  severity: string;
  status: string;
  sourcing_generation_id: string | null;
  resolution_type: string | null;
  resolved_value: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

interface CandidateRow {
  id: string;
  conflict_id: string;
  evidence_attempt_id: string;
  value_json: string;
  created_at: string;
}

function mapCandidate(row: CandidateRow): OnboardingEvidenceConflictCandidate {
  return OnboardingEvidenceConflictCandidateSchema.parse({
    id: row.id,
    conflictId: row.conflict_id,
    evidenceAttemptId: row.evidence_attempt_id,
    valueJson: row.value_json,
    createdAt: row.created_at,
  });
}

function mapConflict(row: ConflictRow, candidates: CandidateRow[]): OnboardingEvidenceConflict {
  return OnboardingEvidenceConflictSchema.parse({
    id: row.id,
    itemId: row.item_id,
    field: row.field,
    severity: row.severity as ConflictSeverity,
    status: row.status as ConflictStatus,
    sourcingGenerationId: row.sourcing_generation_id,
    resolutionType: row.resolution_type,
    resolvedValue: row.resolved_value,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    candidates: candidates.map(mapCandidate),
    createdAt: row.created_at,
  });
}

/**
 * Insert a durable evidence conflict with its candidates (ADR 0014).
 *
 * Idempotent per (item, field, severity, generation): when an OPEN conflict
 * already exists for the same field/generation, the incoming candidate value
 * set is compared; an identical set returns the existing conflict (worker
 * retry cannot duplicate open conflicts), a differing set throws (the worker
 * must not create a second open conflict for the same field). A partial
 * unique index on (item_id, field, sourcing_generation_id) WHERE
 * status='open' is the SQL-level backstop.
 */
export function insertConflictWithCandidates(
  itemId: string,
  field: string,
  severity: ConflictSeverity,
  candidates: Array<{ evidenceAttemptId: string; valueJson: string }>,
  sourcingGenerationId: string | null = null,
): OnboardingEvidenceConflict {
  const db = getDb();

  const existing = db
    .query(
      `SELECT * FROM onboarding_evidence_conflicts
       WHERE item_id = ? AND field = ? AND severity = ? AND status = 'open'
         AND sourcing_generation_id IS ?
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(itemId, field, severity, sourcingGenerationId) as ConflictRow | undefined;

  if (existing) {
    const existingCandidates = db
      .query('SELECT * FROM onboarding_evidence_conflict_candidates WHERE conflict_id = ? ORDER BY created_at ASC')
      .all(existing.id) as CandidateRow[];
    const existingValues = existingCandidates.map((c) => c.value_json).sort();
    const incomingValues = candidates.map((c) => c.valueJson).sort();
    if (JSON.stringify(existingValues) === JSON.stringify(incomingValues)) {
      return mapConflict(existing, existingCandidates);
    }
    throw new Error(
      `Open conflict already exists for item ${itemId} field '${field}' (generation ${sourcingGenerationId ?? 'legacy'}) with a different candidate set`,
    );
  }

  const now = new Date().toISOString();
  const conflictId = `cnf_${randomUUID().slice(0, 8)}`;

  const txn = db.transaction(() => {
    db.query(
      `INSERT INTO onboarding_evidence_conflicts
        (id, item_id, field, severity, status, sourcing_generation_id, created_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?)`,
    ).run(conflictId, itemId, field, severity, sourcingGenerationId, now);

    const candStmt = db.query(
      `INSERT INTO onboarding_evidence_conflict_candidates
        (id, conflict_id, evidence_attempt_id, value_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );

    for (const cand of candidates) {
      const candId = `cand_${randomUUID().slice(0, 8)}`;
      candStmt.run(candId, conflictId, cand.evidenceAttemptId, cand.valueJson, now);
    }
  });
  txn();

  return getConflictById(conflictId)!;
}

export function getConflictById(id: string): OnboardingEvidenceConflict | null {
  const db = getDb();
  const row = db.query('SELECT * FROM onboarding_evidence_conflicts WHERE id = ?').get(id) as ConflictRow | undefined;
  if (!row) return null;

  const candidateRows = db
    .query('SELECT * FROM onboarding_evidence_conflict_candidates WHERE conflict_id = ? ORDER BY created_at ASC')
    .all(id) as CandidateRow[];

  return mapConflict(row, candidateRows);
}

export function listConflictsForItem(itemId: string, statusFilter?: ConflictStatus): OnboardingEvidenceConflict[] {
  const db = getDb();
  let rows: ConflictRow[];

  if (statusFilter) {
    rows = db
      .query('SELECT * FROM onboarding_evidence_conflicts WHERE item_id = ? AND status = ? ORDER BY created_at ASC')
      .all(itemId, statusFilter) as ConflictRow[];
  } else {
    rows = db
      .query('SELECT * FROM onboarding_evidence_conflicts WHERE item_id = ? ORDER BY created_at ASC')
      .all(itemId) as ConflictRow[];
  }

  if (rows.length === 0) return [];

  const conflictIds = rows.map((r) => r.id);
  const placeholders = conflictIds.map(() => '?').join(', ');
  const candidateRows = db
    .query(`SELECT * FROM onboarding_evidence_conflict_candidates WHERE conflict_id IN (${placeholders}) ORDER BY created_at ASC`)
    .all(...conflictIds) as CandidateRow[];

  const candidatesByConflict = new Map<string, CandidateRow[]>();
  for (const cand of candidateRows) {
    if (!candidatesByConflict.has(cand.conflict_id)) {
      candidatesByConflict.set(cand.conflict_id, []);
    }
    candidatesByConflict.get(cand.conflict_id)!.push(cand);
  }

  return rows.map((r) => mapConflict(r, candidatesByConflict.get(r.id) || []));
}

/**
 * Conflicts scoped to the item's exact CURRENT generation only (plus legacy
 * NULL-generation rows when the item has no generations at all). Stale
 * superseded-generation conflicts remain audit-visible via
 * `listConflictsForItem` but are never returned here (Amendment A: current-
 * generation helpers never fall back to a lookup UPC or a stale generation).
 */
export function listCurrentGenerationConflictsForItem(itemId: string, statusFilter?: ConflictStatus): OnboardingEvidenceConflict[] {
  const db = getDb();
  const current = db
    .query('SELECT id FROM sourcing_generations WHERE item_id = ? ORDER BY rowid DESC LIMIT 1')
    .get(itemId) as { id: string } | undefined;

  const generationScope = current ? ` AND sourcing_generation_id = ?` : ` AND sourcing_generation_id IS NULL`;
  const statusClause = statusFilter ? ' AND status = ?' : '';
  const rows = db
    .query(
      `SELECT * FROM onboarding_evidence_conflicts
       WHERE item_id = ?${generationScope}${statusClause}
       ORDER BY created_at ASC`,
    )
    .all(itemId, ...(current ? [current.id] : []), ...(statusFilter ? [statusFilter] : [])) as ConflictRow[];

  if (rows.length === 0) return [];

  const conflictIds = rows.map((r) => r.id);
  const placeholders = conflictIds.map(() => '?').join(', ');
  const candidateRows = db
    .query(`SELECT * FROM onboarding_evidence_conflict_candidates WHERE conflict_id IN (${placeholders}) ORDER BY created_at ASC`)
    .all(...conflictIds) as CandidateRow[];

  const candidatesByConflict = new Map<string, CandidateRow[]>();
  for (const cand of candidateRows) {
    if (!candidatesByConflict.has(cand.conflict_id)) {
      candidatesByConflict.set(cand.conflict_id, []);
    }
    candidatesByConflict.get(cand.conflict_id)!.push(cand);
  }

  return rows.map((r) => mapConflict(r, candidatesByConflict.get(r.id) || []));
}

/**
 * SQL fragment: open HARD conflicts for the item's CURRENT generation only.
 * `IS` unifies both cases with resolveConflict's own guard semantics:
 * - no generation exists → `x IS NULL` matches legacy NULL-generation
 *   conflicts (which ARE resolvable in that state);
 * - a generation exists → only exact-generation matches can block;
 *   legacy NULL-generation conflicts are audit-only and never influence
 *   decisions (ADR 0014 generation-scoped authority), so a legacy conflict
 *   can no longer deadlock routing against resolveConflict's refusal.
 */
const CURRENT_GENERATION_OPEN_HARD_SQL = `
  AND sourcing_generation_id IS (
    SELECT id FROM sourcing_generations
    WHERE item_id = ?
    ORDER BY rowid DESC LIMIT 1
  )`;

/** Open hard conflicts for the item's current generation (any severity hard). */
export function hasUnresolvedHardConflicts(itemId: string): boolean {
  const db = getDb();
  const row = db
    .query(
      `SELECT 1 FROM onboarding_evidence_conflicts
       WHERE item_id = ? AND severity = 'hard' AND status = 'open'` +
        CURRENT_GENERATION_OPEN_HARD_SQL +
        ` LIMIT 1`,
    )
    .get(itemId, itemId);
  return !!row;
}

/**
 * Operator resolution inputs (candidate/custom/dismiss semantics) derived
 * from every RESOLVED conflict of the item's current generation. Used by the
 * manual `use_distributor_record` action and by final conflict resolution so
 * the canonical projection is recomputed with the same authority as
 * automatic routing (MC item 6/7).
 *
 * - `candidate_selected` maps to the selected evidence attempt by matching
 *   the stored `resolved_value` against the conflict's candidate `value_json`;
 * - `custom_override` carries the operator's reviewed value;
 * - `dismissed` removes the field from consideration.
 */
export function listResolvedConflictResolutions(itemId: string): ProjectionResolutionInput[] {
  const db = getDb();
  const current = db
    .query('SELECT id FROM sourcing_generations WHERE item_id = ? ORDER BY rowid DESC LIMIT 1')
    .get(itemId) as { id: string } | undefined;
  if (!current) return [];

  const generationScope = current ? ` AND sourcing_generation_id = ?` : ` AND sourcing_generation_id IS NULL`;
  const rows = db
    .query(
      `SELECT * FROM onboarding_evidence_conflicts
       WHERE item_id = ?${generationScope} AND status = 'resolved' AND resolution_type IS NOT NULL
       ORDER BY created_at ASC`,
    )
    .all(itemId, ...(current ? [current.id] : [])) as ConflictRow[];
  if (rows.length === 0) return [];

  const conflictIds = rows.map((r) => r.id);
  const placeholders = conflictIds.map(() => '?').join(', ');
  const candidateRows = db
    .query(
      `SELECT * FROM onboarding_evidence_conflict_candidates WHERE conflict_id IN (${placeholders}) ORDER BY created_at ASC`,
    )
    .all(...conflictIds) as CandidateRow[];
  const candidatesByConflict = new Map<string, CandidateRow[]>();
  for (const cand of candidateRows) {
    if (!candidatesByConflict.has(cand.conflict_id)) {
      candidatesByConflict.set(cand.conflict_id, []);
    }
    candidatesByConflict.get(cand.conflict_id)!.push(cand);
  }

  const resolutions: ProjectionResolutionInput[] = [];
  for (const row of rows) {
    if (row.resolution_type === 'dismissed') {
      resolutions.push({ field: row.field, kind: 'dismissed' });
    } else if (row.resolution_type === 'custom_override') {
      resolutions.push({
        field: row.field,
        kind: 'custom_override',
        value: row.resolved_value ?? null,
      });
    } else if (row.resolution_type === 'candidate_selected') {
      const candidates = candidatesByConflict.get(row.id) ?? [];
      const selected = candidates.find((c) => c.value_json === row.resolved_value);
      if (selected) {
        resolutions.push({
          field: row.field,
          kind: 'candidate_selected',
          attemptId: selected.evidence_attempt_id,
        });
      } else {
        // Safety: a candidate_selected resolution whose candidate cannot be
        // located is a data-integrity anomaly — fail closed by omitting the
        // field (it was still operator-resolved away from conflict).
        resolutions.push({ field: row.field, kind: 'dismissed' });
      }
    }
  }
  return resolutions;
}

/**
 * Resolve a conflict atomically in a single SQLite transaction (ADR 0014).
 *
 * Guards: the conflict must exist and be OPEN (an already-resolved race is a
 * no-op error); a generation-scoped conflict may only be resolved while it is
 * still the item's CURRENT generation (stale generations are never
 * resolvable). `resolve_candidate` records the candidate's evidence attempt
 * acceptance. When the LAST open hard conflict is resolved and the item is
 * in `sourcing/needs_input`, the transaction completes Sourcing via
 * `completeSourcingWithDecision` with route `evidence_to_discovery` (origin
 * `operator_override`) and moves the item to `discovery/pending` — it NEVER
 * targets Curation, and resolving one of several conflicts leaves the item
 * in `sourcing/needs_input`.
 */
export function resolveConflict(
  conflictId: string,
  request: ResolveConflictRequest,
  resolvedBy = 'operator',
): OnboardingEvidenceConflict {
  const db = getDb();
  const conflict = getConflictById(conflictId);
  if (!conflict) {
    throw new Error(`Conflict ${conflictId} not found`);
  }
  if (conflict.status !== 'open') {
    throw new Error(`Conflict ${conflictId} is already ${conflict.status}`);
  }

  // Exact current-generation guard (ADR 0014): a generation-scoped conflict
  // is resolvable ONLY while it belongs to the item's exact CURRENT (latest)
  // generation — completed, failed, and superseded generations are all
  // stale. A legacy NULL-generation conflict is resolvable only when the
  // item has no generations at all.
  const currentGen = db
    .query('SELECT id FROM sourcing_generations WHERE item_id = ? ORDER BY rowid DESC LIMIT 1')
    .get(conflict.itemId) as { id: string } | undefined;
  if (conflict.sourcingGenerationId) {
    if (!currentGen || currentGen.id !== conflict.sourcingGenerationId) {
      throw new Error(`Conflict ${conflictId} does not belong to the item's current sourcing generation`);
    }
  } else if (currentGen) {
    throw new Error(`Conflict ${conflictId} is a legacy conflict and the item now has a sourcing generation`);
  }

  const now = new Date().toISOString();

  let resolutionType: string;
  let resolvedValue: string | null = null;
  let selectedAttemptId: string | null = null;

  if (request.action === 'resolve_candidate') {
    const candidate = conflict.candidates.find((c) => c.id === request.candidateId);
    if (!candidate) {
      throw new Error(`Candidate ${request.candidateId} not found in conflict ${conflictId}`);
    }
    resolutionType = 'candidate_selected';
    resolvedValue = candidate.valueJson;
    selectedAttemptId = candidate.evidenceAttemptId;
  } else if (request.action === 'custom_value') {
    resolutionType = 'custom_override';
    resolvedValue = request.customValue;
  } else {
    resolutionType = 'dismissed';
  }

  const resolveTxn = db.transaction(() => {
    // 1. CAS-style resolve: only an OPEN conflict flips to resolved.
    const updated = db.query(
      `UPDATE onboarding_evidence_conflicts
       SET status = 'resolved', resolution_type = ?, resolved_value = ?, resolved_by = ?, resolved_at = ?
       WHERE id = ? AND status = 'open'`,
    ).run(resolutionType, resolvedValue, resolvedBy, now, conflictId);
    if (updated.changes === 0) {
      throw new Error(`Conflict ${conflictId} was resolved concurrently`);
    }

    // 2. Record acceptance if a candidate was selected.
    if (selectedAttemptId) {
      recordAcceptances(conflict.itemId, [selectedAttemptId], resolvedBy, `Resolved conflict for field ${conflict.field}`);
    }

    // 3. Re-evaluate remaining open hard conflicts for the item's CURRENT
    //    generation (stale superseded-generation conflicts are audit-only).
    const remainingHard = db
      .query(
        `SELECT COUNT(*) as count FROM onboarding_evidence_conflicts
         WHERE item_id = ? AND severity = 'hard' AND status = 'open'` +
          CURRENT_GENERATION_OPEN_HARD_SQL,
      )
      .get(conflict.itemId, conflict.itemId) as { count: number };

    // 4. Complete Sourcing ONLY when 0 hard conflicts remain AND the item is
    //    still in sourcing/needs_input. The guarded completion recomputes the
    //    canonical projection with the operator's resolution semantics applied
    //    (MC item 6): qualified → Extraction (marker-v1) via
    //    `distributor_record_to_extraction`; accepted-but-insufficient →
    //    `evidence_to_discovery`. Never the previous blanket final step, and
    //    never Curation.
    if (remainingHard.count === 0) {
      // Slice 5a bridge: dual-spelling sourcing guard (same pattern as the
      // item-repo claim predicate).
      const [conflictAltA, conflictAltB] = stagePredicateParams('route_sources');
      const item = db
        .query("SELECT id FROM onboarding_items WHERE id = ? AND (stage = ? OR stage = ?) AND stage_status = 'needs_input'")
        .get(conflict.itemId, conflictAltA, conflictAltB) as { id: string } | undefined;
      if (item) {
        const resolutions = listResolvedConflictResolutions(conflict.itemId);
        const res = completeSourcingViaProjection(conflict.itemId, resolutions);
        if (!res.ok) {
          throw new Error(`Failed to complete sourcing after final conflict resolution: ${res.reason}`);
        }
      }
    }
  });

  resolveTxn();

  return getConflictById(conflictId)!;
}
