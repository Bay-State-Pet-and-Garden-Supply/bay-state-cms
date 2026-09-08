import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';
import type { Database } from '../driver';
import type { ClassificationEvidence, ClassificationProposal, ClassificationProposalDecision } from '../../shared/types';

const now = () => new Date().toISOString();

// ─── Classification Runs ───────────────────────────────────────────────────────

export interface ClassificationRunRow {
  id: string;
  workspaceId: string;
  onboardingItemId: string | null;
  sourceKind: 'onboarding' | 'catalog_product';
  sourceProductHash: string | null;
  productSku: string;
  configSnapshotId: string | null;
  configSnapshotHash: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  /** Parent cohort run (issue #30 PR3); NULL for legacy/non-cohort runs. */
  cohortRunId: string | null;
}

export function createRun(
  workspaceId: string,
  sku: string,
  configSnapshotId: string | null,
  configSnapshotHash: string | null,
  onboardingItemId?: string,
): ClassificationRunRow;
export function createRun(
  workspaceId: string,
  sku: string,
  configSnapshotId: string | null,
  configSnapshotHash: string | null,
  options?: {
    onboardingItemId?: string;
    sourceKind?: 'onboarding' | 'catalog_product';
    sourceProductHash?: string | null;
    /** Link this child SKU run to its parent cohort run (issue #30 PR3). */
    cohortRunId?: string;
  },
): ClassificationRunRow;
export function createRun(
  workspaceId: string,
  sku: string,
  configSnapshotId: string | null,
  configSnapshotHash: string | null,
  optionsOrItemId?: string | {
    onboardingItemId?: string;
    sourceKind?: 'onboarding' | 'catalog_product';
    sourceProductHash?: string | null;
    cohortRunId?: string;
  },
): ClassificationRunRow {
  let onboardingItemId: string | undefined;
  let sourceKind: 'onboarding' | 'catalog_product' = 'onboarding';
  let sourceProductHash: string | null = null;
  let cohortRunId: string | undefined;

  if (typeof optionsOrItemId === 'string') {
    onboardingItemId = optionsOrItemId;
  } else if (optionsOrItemId) {
    onboardingItemId = optionsOrItemId.onboardingItemId;
    sourceKind = optionsOrItemId.sourceKind ?? (optionsOrItemId.onboardingItemId ? 'onboarding' : 'catalog_product');
    sourceProductHash = optionsOrItemId.sourceProductHash ?? null;
    cohortRunId = optionsOrItemId.cohortRunId;
  }

  const id = randomUUID();
  const db = getDb();
  db.run(
    `INSERT INTO classification_runs
     (id, workspace_id, onboarding_item_id, source_kind, source_product_hash,
      product_sku, config_snapshot_id, config_snapshot_hash, status, started_at, cohort_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
    [id, workspaceId, onboardingItemId ?? null, sourceKind, sourceProductHash, sku, configSnapshotId, configSnapshotHash, now(), cohortRunId ?? null],
  );
  return { id, workspaceId, onboardingItemId: onboardingItemId ?? null, sourceKind, sourceProductHash, productSku: sku, configSnapshotId, configSnapshotHash, status: 'running', startedAt: now(), completedAt: null, errorMessage: null, cohortRunId: cohortRunId ?? null };
}

export function completeRun(
  runId: string,
  status: 'completed' | 'completed_with_abstentions' | 'failed',
  errorMessage?: string,
): void {
  getDb().run(
    'UPDATE classification_runs SET status = ?, completed_at = ?, error_message = ? WHERE id = ?',
    [status, now(), errorMessage ?? null, runId],
  );
}

export function getRecentRun(workspaceId: string, sku: string): ClassificationRunRow | null {
  const row = getDb()
    .query('SELECT * FROM classification_runs WHERE workspace_id = ? AND product_sku = ? ORDER BY started_at DESC LIMIT 1')
    .get(workspaceId, sku) as Record<string, any> | undefined;
  if (!row) return null;
  return mapRun(row);
}

export function getRun(id: string): ClassificationRunRow | null {
  const row = getDb()
    .query('SELECT * FROM classification_runs WHERE id = ?')
    .get(id) as Record<string, any> | undefined;
  if (!row) return null;
  return mapRun(row);
}

// ─── Cohort member-run narrow readers (Slice 1: relocated verbatim from
// `src/onboarding/cohort-curator.ts`; statement text, ordering, and
// transaction membership preserved — these compose inside the caller's
// transactions exactly as the inline SQL did) ─────────────────────────────

/**
 * True when a child classification run accumulated model-call or stage side
 * effects (PR3 hardening, Commit A / R4). A running child with side effects
 * under a DIFFERENT snapshot authority is retired (never rebound); a
 * side-effect-free child is re-linked to the new snapshot in place. Both
 * probes run in order with OR semantics, exactly as the inline version.
 */
export function childRunHasSideEffects(childRunId: string): boolean {
  const db = getDb();
  const call = db.query('SELECT 1 FROM classification_model_calls WHERE run_id = ? LIMIT 1').get(childRunId);
  if (call) return true;
  const stage = db.query('SELECT 1 FROM classification_stage_results WHERE run_id = ? LIMIT 1').get(childRunId);
  return Boolean(stage);
}

/** Latest member child lookup (resume guard). LATEST child — NOT latest
 * refs-bearing child; the refs-bearing lookup is
 * `getCohortMemberRunForTitleAudit` (never substitute one for the other). */
export function getLatestMemberChildRun(
  cohortRunId: string,
  onboardingItemId: string,
): { id: string; status: string } | undefined {
  return getDb().query(
    `SELECT id, status FROM classification_runs
     WHERE cohort_run_id = ? AND onboarding_item_id = ?
     ORDER BY started_at DESC LIMIT 1`,
  ).get(cohortRunId, onboardingItemId) as { id: string; status: string } | undefined;
}

/** Proposal rows of one type on a child run, for product-type dependency
 * stamping (`field_assignment` needs id + target_id; `category_page` needs
 * id — one reader serves both with the same row order). */
export function listChildProposalTargets(
  childRunId: string,
  proposalType: string,
): Array<{ id: string; target_id: string | null }> {
  return getDb().query(
    'SELECT id, target_id FROM classification_proposals WHERE run_id = ? AND proposal_type = ?',
  ).all(childRunId, proposalType) as Array<{ id: string; target_id: string | null }>;
}

/**
 * Resolve an onboarding item's persisted run pointer only when every ownership
 * dimension agrees. Curation JSON is a convenience pointer, never authority.
 */
export function getValidatedOnboardingRun(
  runId: string | null | undefined,
  workspaceId: string,
  onboardingItemId: string,
  productSku: string,
): ClassificationRunRow | null {
  if (!runId) return null;
  const row = getDb().query(
    `SELECT * FROM classification_runs
     WHERE id = ? AND workspace_id = ? AND onboarding_item_id = ?
       AND product_sku = ? AND source_kind = 'onboarding'`,
  ).get(runId, workspaceId, onboardingItemId, productSku) as Record<string, any> | undefined;
  return row ? mapRun(row) : null;
}

export function getRecentCatalogRun(workspaceId: string, sku: string): ClassificationRunRow | null {
  const row = getDb()
    .query("SELECT * FROM classification_runs WHERE workspace_id = ? AND product_sku = ? AND source_kind = 'catalog_product' ORDER BY started_at DESC LIMIT 1")
    .get(workspaceId, sku) as Record<string, any> | undefined;
  if (!row) return null;
  return mapRun(row);
}

export function supersedeCatalogProposals(workspaceId: string, sku: string, newRunId: string): void {
  const db = getDb();
  db.run(
    `UPDATE classification_proposals SET is_stale = 1, staleness_reason = 'Superseded by newer catalog run ' || ?, status = 'stale'
     WHERE product_sku = ? AND run_id IN (
       SELECT id FROM classification_runs WHERE workspace_id = ? AND product_sku = ? AND source_kind = 'catalog_product' AND id != ?
     )`,
    [newRunId, sku, workspaceId, sku, newRunId],
  );
}

// ─── Stage Results ─────────────────────────────────────────────────────────────

export function getStageResults(runId: string): Record<string, any>[] {
  return getDb()
    .query('SELECT * FROM classification_stage_results WHERE run_id = ? ORDER BY started_at ASC')
    .all(runId) as Record<string, any>[];
}

// ─── Evidence ──────────────────────────────────────────────────────────────────

export function getEvidenceByRun(runId: string): ClassificationEvidence[] {
  const rows = getDb()
    .query('SELECT * FROM classification_evidence WHERE run_id = ?')
    .all(runId) as Record<string, any>[];
  return rows.map(mapEvidence);
}

// ─── Proposals ─────────────────────────────────────────────────────────────────

export function getProposalsByRun(runId: string): ClassificationProposal[] {
  const rows = getDb()
    .query(`SELECT p.*,
      (SELECT d.revised_value_json FROM classification_proposal_decisions d
        WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
        ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS revised_value_json,
      (SELECT d.revised_target_id FROM classification_proposal_decisions d
        WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
        ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS revised_target_id,
      (SELECT d.id FROM classification_proposal_decisions d
        WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
        ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS current_decision_id,
      (SELECT CASE WHEN d.revised_value_json IS NULL THEN 0 ELSE 1 END FROM classification_proposal_decisions d
        WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
        ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS has_revised_value,
      (SELECT COALESCE(d.has_revised_target, CASE WHEN d.revised_target_id IS NULL THEN 0 ELSE 1 END)
        FROM classification_proposal_decisions d
        WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
        ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS has_revised_target_id
      FROM classification_proposals p WHERE p.run_id = ?`)
    .all(runId) as Record<string, any>[];
  return rows.map(mapProposal);
}

export function getActiveProposalsByRun(runId: string): ClassificationProposal[] {
  return getProposalsByRun(runId).filter(p => !p.isStale && p.status !== 'stale');
}

// fallow-ignore-next-line unused-export — used by tests
export function getPendingPageProposals(productSku: string): ClassificationProposal[] {
  const rows = getDb()
    .query(`SELECT p.*,
      (SELECT d.revised_value_json FROM classification_proposal_decisions d
        WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
        ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS revised_value_json,
      (SELECT d.revised_target_id FROM classification_proposal_decisions d
        WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
        ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS revised_target_id,
      (SELECT d.id FROM classification_proposal_decisions d
        WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
        ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS current_decision_id,
      (SELECT CASE WHEN d.revised_value_json IS NULL THEN 0 ELSE 1 END FROM classification_proposal_decisions d
        WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
        ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS has_revised_value,
      (SELECT COALESCE(d.has_revised_target, CASE WHEN d.revised_target_id IS NULL THEN 0 ELSE 1 END)
        FROM classification_proposal_decisions d
        WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
        ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS has_revised_target_id
      FROM classification_proposals p WHERE p.product_sku = ? AND p.proposal_type = ? AND p.status = ? ORDER BY p.confidence DESC`)
    .all(productSku, 'category_page', 'pending') as Record<string, any>[];
  return rows.map(mapProposal);
}

export function getAcceptedProposals(productSku: string, runId?: string): ClassificationProposal[] {
  if (runId) {
    const rows = getDb()
      .query(`SELECT p.*,
        (SELECT d.revised_value_json FROM classification_proposal_decisions d
          WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
          ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS revised_value_json,
        (SELECT d.revised_target_id FROM classification_proposal_decisions d
          WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
          ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS revised_target_id,
        (SELECT d.id FROM classification_proposal_decisions d
          WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
          ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS current_decision_id,
        (SELECT CASE WHEN d.revised_value_json IS NULL THEN 0 ELSE 1 END FROM classification_proposal_decisions d
          WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
          ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS has_revised_value,
        (SELECT COALESCE(d.has_revised_target, CASE WHEN d.revised_target_id IS NULL THEN 0 ELSE 1 END)
          FROM classification_proposal_decisions d
          WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
          ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS has_revised_target_id
        FROM classification_proposals p
        WHERE p.product_sku = ? AND p.run_id = ? AND p.status = ?
          AND (SELECT d.decision FROM classification_proposal_decisions d
               WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
               ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) = ?`)
      .all(productSku, runId, 'accepted', 'accepted') as Record<string, any>[];
    return rows.map(mapProposal);
  }
  const rows = getDb()
    .query(`SELECT p.*,
      (SELECT d.revised_value_json FROM classification_proposal_decisions d
        WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
        ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS revised_value_json,
      (SELECT d.revised_target_id FROM classification_proposal_decisions d
        WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
        ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS revised_target_id,
      (SELECT d.id FROM classification_proposal_decisions d
        WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
        ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS current_decision_id,
      (SELECT CASE WHEN d.revised_value_json IS NULL THEN 0 ELSE 1 END FROM classification_proposal_decisions d
        WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
        ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS has_revised_value,
      (SELECT COALESCE(d.has_revised_target, CASE WHEN d.revised_target_id IS NULL THEN 0 ELSE 1 END)
        FROM classification_proposal_decisions d
        WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
        ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS has_revised_target_id
      FROM classification_proposals p
      WHERE p.product_sku = ? AND p.status = ?
        AND (SELECT d.decision FROM classification_proposal_decisions d
             WHERE d.proposal_id = p.id AND d.superseded_at IS NULL
             ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) = ?`)
    .all(productSku, 'accepted', 'accepted') as Record<string, any>[];
  console.warn(`[ClassificationRunRepo] getAcceptedProposals called without runId for SKU ${productSku} — results are unscoped and may span multiple runs.`);
  return rows.map(mapProposal);
}

// ─── Decision Revisions ──────────────────────────────────────────────────────

export class DecisionConflictError extends Error {
  readonly code = 'decision_conflict';

  constructor(message: string) {
    super(message);
    this.name = 'DecisionConflictError';
  }
}

export interface DecisionRowInput {
  id?: string;
  proposalId: string;
  decision: 'accepted' | 'rejected' | 'deferred';
  /** Optimistic-concurrency predecessor. Null means the caller observed no live decision. */
  expectedRevisionId?: string | null;
  /** @deprecated Transitional alias for expectedRevisionId. */
  revisedFromId?: string | null;
  reviewerId?: string | null;
  reviewerNote?: string | null;
  /** Undefined = no correction; any other value (including null) is a correction. */
  revisedValue?: unknown;
  revisedTargetId?: string | null;
  createdAt?: string;
  /** Explicit token for one user action. Network retries must reuse this token. */
  actionToken?: string | null;
  /** @deprecated Database/backward-compatible alias for actionToken. */
  decisionKey?: string | null;
  /**
   * Evidence citations for this correction (issue #17 I). Optional; part of
   * exact retry/idempotency equality. Persisted append-only in
   * classification_proposal_decision_evidence inside the same transaction.
   */
  evidenceIds?: string[];
  decisionOrigin?: string | null;
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function correctionJson(input: DecisionRowInput): string | null {
  return hasOwn(input, 'revisedValue') && input.revisedValue !== undefined
    ? JSON.stringify(input.revisedValue)
    : null;
}

function inputHasRevisedTarget(input: DecisionRowInput): boolean {
  return hasOwn(input, 'revisedTargetId');
}

function rowHasRevisedTarget(row: Record<string, any>): boolean {
  if (row.has_revised_target !== null && row.has_revised_target !== undefined) {
    return Number(row.has_revised_target) === 1;
  }
  // Pre-column rows: any non-null target id is treated as a present correction.
  return row.revised_target_id !== null && row.revised_target_id !== undefined;
}

function rowMatchesInput(row: Record<string, any>, input: DecisionRowInput): boolean {
  const inputHasRevision = hasOwn(input, 'revisedValue') && input.revisedValue !== undefined;
  const rowHasRevision = row.revised_value_json !== null && row.revised_value_json !== undefined;
  const inputHasTarget = inputHasRevisedTarget(input);
  const rowHasTarget = rowHasRevisedTarget(row);
  // Citations are part of exact retry/idempotency equality: a delayed retry
  // cannot alter the cited evidence set or become live again (issue #17 I).
  const inputCitations = [...new Set(input.evidenceIds ?? [])].sort().join('\u0000');
  const storedCitations = getDecisionEvidenceIds(getDb(), String(row.id)).join('\u0000');
  return String(row.proposal_id) === input.proposalId
    && String(row.decision) === input.decision
    && (row.reviewer_id === null ? null : String(row.reviewer_id)) === (input.reviewerId ?? null)
    && (row.reviewer_note === null ? null : String(row.reviewer_note)) === (input.reviewerNote ?? null)
    && rowHasRevision === inputHasRevision
    && (!inputHasRevision || String(row.revised_value_json) === correctionJson(input))
    && rowHasTarget === inputHasTarget
    && (!inputHasTarget || (row.revised_target_id === null ? null : String(row.revised_target_id)) === (input.revisedTargetId ?? null))
    && storedCitations === inputCitations;
}

/** Sorted, deduplicated evidence ids cited by a decision (issue #17 I). */
function getDecisionEvidenceIds(db: Database, decisionId: string): string[] {
  const rows = db.query(
    'SELECT evidence_id FROM classification_proposal_decision_evidence WHERE decision_id = ? ORDER BY evidence_id',
  ).all(decisionId) as Array<{ evidence_id: string }>;
  return rows.map(r => String(r.evidence_id));
}

function getLiveDecisionRow(db: Database, proposalId: string): Record<string, any> | undefined {
  return db.query(
    `SELECT * FROM classification_proposal_decisions
     WHERE proposal_id = ? AND superseded_at IS NULL
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(proposalId) as Record<string, any> | undefined;
}

/**
 * Insert one decision row inside the caller's transaction (or standalone via
 * recordDecision). An explicit action token makes retries safe even after a
 * newer revision exists. Optimistic predecessor checking prevents stale edits
 * (including legacy requests without a predecessor) from superseding newer work.
 */
export function insertDecisionRow(
  db: Database,
  input: DecisionRowInput,
): { decision: ClassificationProposalDecision; inserted: boolean; decisionId: string } {
  const suppliedToken = input.actionToken ?? input.decisionKey ?? null;
  const actionToken = suppliedToken?.trim() || randomUUID();

  // Retry lookup comes before predecessor validation: a delayed retry of an old
  // action returns that historical row and can never make it live again.
  const tokenRow = db.query(
    'SELECT * FROM classification_proposal_decisions WHERE decision_key = ?',
  ).get(actionToken) as Record<string, any> | undefined;
  if (tokenRow) {
    if (input.id && String(tokenRow.id) !== input.id) {
      throw new DecisionConflictError('The decision id does not match the action token owner.');
    }
    const expectedProvided = hasOwn(input, 'expectedRevisionId') || hasOwn(input, 'revisedFromId');
    const expectedRevisionId = hasOwn(input, 'expectedRevisionId')
      ? input.expectedRevisionId ?? null
      : input.revisedFromId ?? null;
    const storedPredecessor = tokenRow.revised_from_id === null ? null : String(tokenRow.revised_from_id);
    if (!rowMatchesInput(tokenRow, input) || (expectedProvided && storedPredecessor !== expectedRevisionId)) {
      throw new DecisionConflictError('The decision action token is already associated with a different payload.');
    }
    const decision = mapDecision(tokenRow);
    return { decision, inserted: false, decisionId: decision.id };
  }

  if (input.id) {
    const idRow = db.query('SELECT * FROM classification_proposal_decisions WHERE id = ?').get(input.id) as Record<string, any> | undefined;
    if (idRow) {
      throw new DecisionConflictError('The decision id is already associated with another action.');
    }
  }

  const current = getLiveDecisionRow(db, input.proposalId);
  const expectedProvided = hasOwn(input, 'expectedRevisionId') || hasOwn(input, 'revisedFromId');
  const expectedRevisionId = hasOwn(input, 'expectedRevisionId')
    ? input.expectedRevisionId ?? null
    : input.revisedFromId ?? null;
  const currentId = current ? String(current.id) : null;

  if (expectedProvided && expectedRevisionId !== currentId) {
    throw new DecisionConflictError('The proposal decision changed after it was loaded. Refresh and retry the edit.');
  }

  if (!expectedProvided && current) {
    // Backward-compatible immediate retry is safe only when it is identical to
    // the currently live row. A different legacy edit must refresh and provide
    // the optimistic predecessor rather than risk an out-of-order overwrite.
    if (rowMatchesInput(current, input)) {
      const decision = mapDecision(current);
      return { decision, inserted: false, decisionId: decision.id };
    }
    throw new DecisionConflictError('A predecessor decision id is required to revise an existing decision.');
  }

  if (current && rowMatchesInput(current, input)) {
    const decision = mapDecision(current);
    return { decision, inserted: false, decisionId: decision.id };
  }

  const createdAt = input.createdAt ?? now();
  const decisionId = input.id ?? randomUUID();
  const revisedFromId = currentId;
  const revisedValueJson = correctionJson(input);
  const hasRevisedTarget = inputHasRevisedTarget(input) ? 1 : 0;
  const revisedTargetId = hasRevisedTarget ? (input.revisedTargetId ?? null) : null;
  const decisionOrigin = input.decisionOrigin ?? (input.reviewerId === 'system_auto_accept' ? 'system_auto_accept' : 'human_review');

  // Plain INSERT is intentional: only a previously verified action token may
  // be treated as an idempotent retry. PK/FK/CHECK conflicts must fail.
  db.run(
    `INSERT INTO classification_proposal_decisions
     (id, proposal_id, decision, revised_from_id, reviewer_id, reviewer_note,
      revised_value_json, revised_target_id, has_revised_target, decision_key,
      decision_origin, superseded_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [
      decisionId,
      input.proposalId,
      input.decision,
      revisedFromId,
      input.reviewerId ?? null,
      input.reviewerNote ?? null,
      revisedValueJson,
      revisedTargetId,
      hasRevisedTarget,
      actionToken,
      decisionOrigin,
      createdAt,
    ],
  );

  const newStatus = input.decision === 'accepted' ? 'accepted' : input.decision === 'rejected' ? 'rejected' : 'deferred';
  db.run('UPDATE classification_proposals SET status = ? WHERE id = ?', [newStatus, input.proposalId]);
  db.run(
    `UPDATE classification_proposal_decisions SET superseded_at = ?
     WHERE proposal_id = ? AND id != ? AND superseded_at IS NULL`,
    [createdAt, input.proposalId, decisionId],
  );

  // Persist the decision's evidence citations append-only in the same
  // transaction (issue #17 I). Citations are sorted + deduplicated for
  // deterministic ordering. Validation that each id belongs to the same
  // run/SKU and is linked to the proposal happened in the review service
  // BEFORE this insert was invoked.
  const citations = [...new Set(input.evidenceIds ?? [])].sort();
  if (citations.length > 0) {
    const citationStmt = db.prepare(
      'INSERT OR IGNORE INTO classification_proposal_decision_evidence (decision_id, evidence_id) VALUES (?, ?)',
    );
    for (const evidenceId of citations) {
      citationStmt.run(decisionId, evidenceId);
    }
  }

  const decision = mapDecision(db.query(
    'SELECT * FROM classification_proposal_decisions WHERE id = ?',
  ).get(decisionId) as Record<string, any>);
  return { decision, inserted: true, decisionId };
}

/** Supersede active decisions without deleting audit history. */
export function supersedeDecisionsForProposals(proposalIds: string[], at?: string): void {
  if (proposalIds.length === 0) return;
  const db = getDb();
  const placeholders = proposalIds.map(() => '?').join(', ');
  db.run(
    `UPDATE classification_proposal_decisions SET superseded_at = ?
     WHERE proposal_id IN (${placeholders}) AND superseded_at IS NULL`,
    [at ?? now(), ...proposalIds],
  );
}

/** Standalone atomic decision write for direct/test callers. */
export function recordDecision(decision: ClassificationProposalDecision): { inserted: boolean; decisionId: string } {
  const db = getDb();
  let result: { inserted: boolean; decisionId: string } = { inserted: false, decisionId: decision.id };
  db.transaction(() => {
    const row = insertDecisionRow(db, {
      id: decision.id,
      proposalId: decision.proposalId,
      decision: decision.decision,
      expectedRevisionId: decision.revisedFromId,
      reviewerId: decision.reviewerId,
      reviewerNote: decision.reviewerNote,
      ...(decision.hasRevisedValue ? { revisedValue: decision.revisedValue } : {}),
      ...(decision.hasRevisedTargetId ? { revisedTargetId: decision.revisedTargetId } : {}),
      actionToken: decision.actionToken ?? decision.decisionKey,
      createdAt: decision.createdAt,
    });
    result = { inserted: row.inserted, decisionId: row.decisionId };
  })();
  return result;
}

export function getLiveDecisionsByRun(runId: string): ClassificationProposalDecision[] {
  const rows = getDb().query(
    `SELECT d.* FROM classification_proposal_decisions d
     JOIN classification_proposals p ON p.id = d.proposal_id
     WHERE p.run_id = ? AND d.superseded_at IS NULL
       AND d.rowid = (
         SELECT d2.rowid FROM classification_proposal_decisions d2
         WHERE d2.proposal_id = d.proposal_id AND d2.superseded_at IS NULL
         ORDER BY d2.created_at DESC, d2.rowid DESC LIMIT 1
       )
     ORDER BY d.created_at DESC, d.rowid DESC`,
  ).all(runId) as Record<string, any>[];
  return rows.map(mapDecision);
}

// ─── History Events ────────────────────────────────────────────────────────────

export function recordHistoryEvent(
  workspaceId: string,
  productSku: string,
  eventType: string,
  eventJson: Record<string, unknown>,
  runId?: string,
  proposalId?: string,
  decisionId?: string,
): void {
  getDb().run(
    `INSERT INTO classification_history_events
     (id, workspace_id, product_sku, run_id, proposal_id, decision_id, event_type, event_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      workspaceId,
      productSku,
      runId ?? null,
      proposalId ?? null,
      decisionId ?? null,
      eventType,
      JSON.stringify(eventJson),
      now(),
    ],
  );
}

// ─── Dependent Refresh Queue ────────────────────────────────────────────────────

/**
 * Enqueue a dependent classification refresh for a product. A dependent
 * refresh is required whenever a Primary Product Type decision changes so the
 * next run's snapshot can cite the accepted decision as a reviewed fact and
 * unlock type-gated attribute/Page proposals.
 *
 * Deduplicates against an already-queued refresh for the same product and
 * trigger; failed/completed rows do not block a new refresh.
 */
export function enqueueClassificationRefresh(input: {
  workspaceId: string;
  productSku: string;
  triggerType: string;
  refreshScope?: Record<string, unknown>;
  requestedBy?: string | null;
}): void {
  const db = getDb();
  const queued = db.query(
    `SELECT 1 FROM classification_refresh_queue
     WHERE workspace_id = ? AND product_sku = ? AND trigger_type = ? AND status = 'queued'
     LIMIT 1`,
  ).get(input.workspaceId, input.productSku, input.triggerType);
  if (queued) return;

  db.run(
    `INSERT INTO classification_refresh_queue
     (id, workspace_id, product_sku, trigger_type, refresh_scope_json, status, requested_by, requested_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`,
    [
      randomUUID(),
      input.workspaceId,
      input.productSku,
      input.triggerType,
      JSON.stringify(input.refreshScope ?? {}),
      input.requestedBy ?? null,
      now(),
    ],
  );
}

// ─── Mappers ───────────────────────────────────────────────────────────────────

function mapRun(row: Record<string, any>): ClassificationRunRow {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    onboardingItemId: row.onboarding_item_id ? String(row.onboarding_item_id) : null,
    sourceKind: String(row.source_kind || 'onboarding') as 'onboarding' | 'catalog_product',
    sourceProductHash: row.source_product_hash ? String(row.source_product_hash) : null,
    productSku: String(row.product_sku),
    configSnapshotId: row.config_snapshot_id ? String(row.config_snapshot_id) : null,
    configSnapshotHash: row.config_snapshot_hash ? String(row.config_snapshot_hash) : null,
    status: String(row.status),
    startedAt: String(row.started_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    cohortRunId: row.cohort_run_id ? String(row.cohort_run_id) : null,
  };
}

function mapEvidence(row: Record<string, any>): ClassificationEvidence {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    stageName: String(row.stage_name) as ClassificationEvidence['stageName'],
    productSku: String(row.product_sku),
    attributeId: row.attribute_id ? String(row.attribute_id) : null,
    source: String(row.source) as ClassificationEvidence['source'],
    reliability: String(row.reliability) as ClassificationEvidence['reliability'],
    sourceUrl: row.source_url ? String(row.source_url) : null,
    sourceField: row.source_field ? String(row.source_field) : null,
    snippet: row.snippet ? String(row.snippet) : null,
    value: row.value_json ? JSON.parse(String(row.value_json)) : null,
    metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : null,
    capturedAt: String(row.created_at),
  };
}

function mapProposal(row: Record<string, any>): ClassificationProposal {
  const hasRevisedValue = Number(row.has_revised_value) === 1;
  const hasRevisedTargetId = Number(row.has_revised_target_id) === 1;
  // Authoritative evidence roles come from the relation join, never the
  // denormalized JSON columns (which can drift). The union stays the
  // backward-compatible evidenceIds for legacy rows without relation rows.
  const relations = evidenceRelationsForProposal(String(row.id));
  const supportingEvidenceIds = relations.filter(r => r.relation === 'supporting').map(r => r.evidenceId);
  const contradictingEvidenceIds = relations.filter(r => r.relation === 'contradicting').map(r => r.evidenceId);
  return {
    id: String(row.id),
    runId: String(row.run_id),
    productSku: String(row.product_sku),
    proposalType: String(row.proposal_type) as ClassificationProposal['proposalType'],
    targetId: row.target_id ? String(row.target_id) : null,
    proposedValue: row.proposed_value_json ? JSON.parse(String(row.proposed_value_json)) : null,
    confidence: Number(row.confidence),
    evidenceIds: row.evidence_ids_json ? JSON.parse(String(row.evidence_ids_json)) : [],
    ...(supportingEvidenceIds.length ? { supportingEvidenceIds } : {}),
    ...(contradictingEvidenceIds.length ? { contradictingEvidenceIds } : {}),
    ...(row.derivation_json
      ? { derivation: JSON.parse(String(row.derivation_json)) }
      : {}),
    ...(row.model_call_ids_json
      ? { modelCallIds: JSON.parse(String(row.model_call_ids_json)) as string[] }
      : {}),
    status: String(row.status) as ClassificationProposal['status'],
    isBulkAcceptable: Number(row.is_bulk_acceptable) === 1,
    isStale: Number(row.is_stale) === 1,
    stalenessReason: row.staleness_reason ? String(row.staleness_reason) : null,
    ...(hasRevisedValue ? { revisedValue: JSON.parse(String(row.revised_value_json)) } : {}),
    hasRevisedValue,
    // Explicit null target clear is a present correction; keep the key when has=true.
    ...(hasRevisedTargetId
      ? { revisedTargetId: row.revised_target_id === null || row.revised_target_id === undefined ? null : String(row.revised_target_id) }
      : {}),
    hasRevisedTargetId,
    currentDecisionId: row.current_decision_id ? String(row.current_decision_id) : null,
    createdAt: String(row.created_at),
  };
}

interface ProposalEvidenceRelation {
  evidenceId: string;
  relation: 'supporting' | 'contradicting' | 'context' | 'legacy';
}

/**
 * Authoritative evidence roles for a proposal, read from the relation join
 * (issue #17 H / pass 5b). Roles are NEVER derived from the denormalized JSON
 * columns on read; the join is the single source of truth.
 */
function evidenceRelationsForProposal(proposalId: string): ProposalEvidenceRelation[] {
  const rows = getDb().query(
    'SELECT evidence_id, relation FROM classification_proposal_evidence WHERE proposal_id = ? ORDER BY rowid',
  ).all(proposalId) as Array<{ evidence_id: string; relation: string }>;
  return rows.map(row => ({
    evidenceId: String(row.evidence_id),
    relation: String(row.relation) as ProposalEvidenceRelation['relation'],
  }));
}

function mapDecision(row: Record<string, any>): ClassificationProposalDecision {
  const hasRevisedValue = row.revised_value_json !== null && row.revised_value_json !== undefined;
  const hasRevisedTargetId = rowHasRevisedTarget(row);
  const actionToken = row.decision_key ? String(row.decision_key) : null;
  return {
    id: String(row.id),
    proposalId: String(row.proposal_id),
    decision: String(row.decision) as ClassificationProposalDecision['decision'],
    revisedFromId: row.revised_from_id ? String(row.revised_from_id) : null,
    reviewerId: row.reviewer_id ? String(row.reviewer_id) : null,
    reviewerNote: row.reviewer_note ? String(row.reviewer_note) : null,
    ...(hasRevisedValue ? { revisedValue: JSON.parse(String(row.revised_value_json)) } : {}),
    hasRevisedValue,
    ...(hasRevisedTargetId
      ? { revisedTargetId: row.revised_target_id === null || row.revised_target_id === undefined ? null : String(row.revised_target_id) }
      : {}),
    hasRevisedTargetId,
    actionToken,
    decisionKey: actionToken,
    decisionOrigin: row.decision_origin ? String(row.decision_origin) : null,
    supersededAt: row.superseded_at ? String(row.superseded_at) : null,
    createdAt: String(row.created_at),
    ...(hydrateDecisionCitations(row.id) ? { evidenceIds: hydrateDecisionCitations(row.id) } : {}),
  };
}

/** Sorted evidence ids cited by a decision, hydrated via the join table. */
function hydrateDecisionCitations(decisionId: unknown): string[] {
  const id = String(decisionId);
  const rows = getDb().query(
    'SELECT evidence_id FROM classification_proposal_decision_evidence WHERE decision_id = ? ORDER BY evidence_id',
  ).all(id) as Array<{ evidence_id: string }>;
  return rows.map(r => String(r.evidence_id));
}
