/**
 * Cohort run repository (issue #30, PR3 M1).
 *
 * Function module (no class): snake_case row interfaces + camelCase mappers,
 * `randomUUID()` ids, ISO `now()` timestamps, positional `?` params, and
 * `db.transaction(() => {})()` for multi-table writes — following the
 * curation-cohort-repo / classification-run-repo conventions.
 *
 * Lifecycle (PR3 M1 contract): `claimReadyCurationCohorts` atomically inserts
 * a `freezing` run row with the claim lease and the frozen candidate
 * membership hash (H1 = cohort.membership_hash at claim). `freezing → running`
 * happens only after the freeze engine's final CAS transaction commits
 * (M2); the M1 primitives are `freezeCohortRunAuthorities` (ownership-guarded
 * authority write) + `transitionCohortRunToRunning`. Terminal writes are
 * `completeCohortRun` (write-once) and `supersedeCohortRun` (settable from
 * ANY state including terminal ones; also fails linked running children so
 * `idx_classification_runs_one_running_item` never blocks a member retry).
 *
 * The unique partial index `idx_classification_cohort_runs_current`
 * (`cohort_id WHERE status != 'superseded'`) is the DB-level race backstop:
 * at most one current run per cohort, and superseding frees the slot for a
 * legitimate retry. `getCurrentCohortRun` reads that invariant directly.
 *
 * Reclaim (PR3 hardening, Commit A): `reclaimExpiredCohortRuns` compares
 * `lease_expires_at < :nowIso` (expiry timestamps compare to NOW — callers pass
 * `new Date().toISOString()`, never `now - TTL`). RESUME is a CAS on the
 * observed `{claimed_by, lease_expires_at, status}` (the EXACT observed status
 * — Commit A2): `changes === 0` means the row changed since selection
 * (another worker resumed it, it left the observed status, or it was
 * finalized/transitioned in place) and the run is NEVER handed out. The drift
 * branch supersedes via `supersedeCohortRunIfUnchanged` — a stale drift
 * verdict can never supersede a run another worker already resumed.
 */
import { getDb } from '../connection';
import { createRun, getRun } from './classification-run-repo';
import { randomUUID } from 'node:crypto';
import { readStorageVersion, encodeForStorage, toCanonicalStored } from './onboarding-stage-vocabulary-repo';
import { HeartbeatLostError } from '../../classification/heartbeat-errors';
import type { ClassificationRunRow } from './classification-run-repo';
import type { CohortRun, ProposalDependency, ExecutionProductTypeOutcome } from '../../shared/schemas/cohorts';

const now = () => new Date().toISOString();

// ─── Row interface (snake_case) ───────────────────────────────────────────────

export interface CohortRunRow {
  id: string;
  workspace_id: string;
  cohort_id: string;
  candidate_membership_hash: string;
  final_membership_hash: string | null;
  evidence_snapshot_hash: string | null;
  evidence_snapshot_id: string | null;
  config_snapshot_id: string | null;
  config_snapshot_hash: string | null;
  page_import_id: string | null;
  page_import_hash: string | null;
  model_policy_digest: string | null;
  execution_product_type_id: string | null;
  product_type_confidence: number | null;
  product_type_outcome: string | null;
  status: string;
  claimed_by: string | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  superseded_at: string | null;
  created_at: string;
}

// ─── Mapper (snake → camel) ───────────────────────────────────────────────────

export function mapCohortRunRow(row: Record<string, any>): CohortRun {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    cohortId: row.cohort_id,
    candidateMembershipHash: row.candidate_membership_hash,
    finalMembershipHash: row.final_membership_hash ?? null,
    evidenceSnapshotHash: row.evidence_snapshot_hash ?? null,
    evidenceSnapshotId: row.evidence_snapshot_id ?? null,
    configSnapshotId: row.config_snapshot_id ?? null,
    configSnapshotHash: row.config_snapshot_hash ?? null,
    pageImportId: row.page_import_id ?? null,
    pageImportHash: row.page_import_hash ?? null,
    modelPolicyDigest: row.model_policy_digest ?? null,
    executionProductTypeId: row.execution_product_type_id ?? null,
    productTypeConfidence: row.product_type_confidence === null || row.product_type_confidence === undefined ? null : Number(row.product_type_confidence),
    productTypeOutcome: row.product_type_outcome ?? null,
    status: row.status,
    claimedBy: row.claimed_by ?? null,
    claimedAt: row.claimed_at ?? null,
    leaseExpiresAt: row.lease_expires_at ?? null,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    errorMessage: row.error_message ?? null,
    supersededAt: row.superseded_at ?? null,
    createdAt: row.created_at,
  };
}

// ─── Claim / lease ────────────────────────────────────────────────────────────

/**
 * Default cohort claim lease TTL. A multi-SKU cohort curation (freeze + N
 * pipeline runs + OCR + model calls) exceeds the item-claim window, so the
 * cohort lease gets its own tunable TTL (heartbeat piggybacks on member
 * boundaries in M3).
 */
export const COHORT_LEASE_TTL_MS = 15 * 60 * 1000;

/**
 * Atomically claim up to `limit` ready curation cohorts for `workerId`.
 *
 * One INSERT...SELECT: creates a `freezing` run row per claimed cohort with
 * the claim lease (`claimed_by`/`claimed_at`/`lease_expires_at`), the frozen
 * `candidate_membership_hash` copied from the candidate cohort, and all frozen
 * authority hashes NULL (they are captured by the freeze engine before the
 * `freezing → running` transition).
 *
 * Guards: the cohort must be `ready` AND have no current (non-superseded)
 * run. The unique partial index `idx_classification_cohort_runs_current` is
 * the DB backstop — a simultaneous second writer either matches 0 rows or
 * throws UNIQUE; both resolve to `[]` (lose the race, claim nothing).
 *
 * The run row is the claim: nothing on `curation_cohorts` changes when a
 * cohort is claimed ("Curation running" is derived from run rows).
 */
export function claimReadyCurationCohorts(
  workspaceId: string,
  limit: number,
  workerId: string,
  leaseTtlMs: number,
): CohortRun[] {
  const db = getDb();
  const nowIso = now();
  const leaseExpiresAt = new Date(Date.now() + leaseTtlMs).toISOString();

  try {
    // Single atomic INSERT...SELECT (autocommit, one statement) claiming up to
    // `limit` ready cohorts that have no current (non-superseded) run.
    // RETURNING captures the exact inserted rows — unlike the item-claim
    // (workerId, claimed_at) read-back, an INSERT can return its own rows, so
    // two claims from the same worker within one millisecond can never be
    // confused. Guards: the cohort must be `ready` AND have no current run
    // (duplicated outer guards mirror the claimItemsForProcessing idiom); the
    // owning batch must be active AND execution_state = 'running' — a paused
    // batch never accumulates new lease rows (the dispatch-side gate in the
    // worker covers already-claimed runs). The unique partial index
    // idx_classification_cohort_runs_current is the DB backstop.
    const rows = db.query(
      `INSERT INTO classification_cohort_runs
        (id, workspace_id, cohort_id, candidate_membership_hash, status,
         claimed_by, claimed_at, lease_expires_at, created_at)
       SELECT lower(hex(randomblob(16))), c.workspace_id, c.id, c.membership_hash, 'freezing',
              ?, ?, ?, ?
       FROM curation_cohorts c
       JOIN onboarding_batches b ON b.id = c.batch_id
       WHERE c.id IN (
         SELECT c2.id FROM curation_cohorts c2
         JOIN onboarding_batches b2 ON b2.id = c2.batch_id
         WHERE c2.workspace_id = ? AND c2.status = 'ready'
           AND b2.status = 'active' AND b2.execution_state = 'running'
           AND NOT EXISTS (
             SELECT 1 FROM classification_cohort_runs r
             WHERE r.cohort_id = c2.id AND r.status != 'superseded'
           )
           AND EXISTS (
             SELECT 1 FROM curation_cohort_members m
             JOIN onboarding_items i ON i.id = m.onboarding_item_id
             WHERE m.cohort_id = c2.id AND i.stage NOT IN ('review', 'promotion', 'review_listings', 'create_drafts')
           )
         ORDER BY c2.updated_at ASC
         LIMIT ?
       )
       AND c.status = 'ready'
       AND b.status = 'active' AND b.execution_state = 'running'
       AND NOT EXISTS (
         SELECT 1 FROM classification_cohort_runs r
         WHERE r.cohort_id = c.id AND r.status != 'superseded'
       )
       AND EXISTS (
         SELECT 1 FROM curation_cohort_members m
         JOIN onboarding_items i ON i.id = m.onboarding_item_id
         WHERE m.cohort_id = c.id AND i.stage NOT IN ('review', 'promotion', 'review_listings', 'create_drafts')
       )
       RETURNING *`,
    ).all(workerId, nowIso, leaseExpiresAt, nowIso, workspaceId, limit) as Record<string, any>[];
    return rows.map(mapCohortRunRow);
  } catch (err) {
    // Race loser against idx_classification_cohort_runs_current: resolve to
    // an empty claim (refreshCandidateCohorts precedent).
    const isUniqueRace = err instanceof Error && err.message.includes('UNIQUE constraint failed');
    if (isUniqueRace) return [];
    throw err;
  }
}

// ─── Child member runs (freeze path) ──────────────────────────────────────────

/**
 * Idempotent child-run create/lookup for a cohort member (PR3 M1). Returns
 * the existing RUNNING child run linked to this parent cohort run for the
 * item when one exists; otherwise creates it via `createRun` with the
 * `cohortRunId` linkage. Crash recovery reuses this instead of blindly
 * creating duplicate running rows (which the one-running-item index would
 * reject anyway).
 */
export function ensureMemberRun(
  parentRunId: string,
  itemId: string,
  workspaceId: string,
  sku: string,
  configSnapshotId: string | null,
  configSnapshotHash: string | null,
): ClassificationRunRow {
  const existing = getDb().query(
    `SELECT * FROM classification_runs
     WHERE cohort_run_id = ? AND onboarding_item_id = ? AND status = 'running'
     ORDER BY started_at DESC LIMIT 1`,
  ).get(parentRunId, itemId) as Record<string, any> | undefined;
  if (existing) return createRunLookup(existing.id);
  return createRun(workspaceId, sku, configSnapshotId, configSnapshotHash, {
    onboardingItemId: itemId,
    cohortRunId: parentRunId,
  });
}

function createRunLookup(runId: string): ClassificationRunRow {
  const row = getRun(runId);
  if (!row) throw new Error(`Member classification run ${runId} disappeared`);
  return row;
}

/**
 * PURE READ (PR6 review BLOCKER 2 fix): the member child run the parent title
 * op's audited `cohort_title_consolidation` call binds to (DECISION-N).
 *
 * NEVER creates and NEVER updates anything — the parent op performs ZERO
 * writes before the lease is asserted, so the reuse path is entirely
 * read-only. Returns the LATEST child for the member (running or terminal;
 * a crash mid-ref-inheritance can leave the newest child with NULL snapshot
 * refs, in which case the most recent refs-bearing child is the frozen audit
 * authority). null when the member has no child carrying the immutable
 * freeze-persisted snapshot refs — the caller must fail closed.
 */
export function getCohortMemberRunForTitleAudit(
  parentRunId: string,
  itemId: string,
): ClassificationRunRow | null {
  const withRefs = getDb().query(
    `SELECT id FROM classification_runs
     WHERE cohort_run_id = ? AND onboarding_item_id = ?
       AND config_snapshot_id IS NOT NULL AND config_snapshot_hash IS NOT NULL
     ORDER BY started_at DESC LIMIT 1`,
  ).get(parentRunId, itemId) as { id: string } | undefined;
  if (!withRefs) return null;
  return createRunLookup(withRefs.id);
}

// ─── Cohort member-run narrow writers/readers (Slice 1: relocated verbatim
// from `src/onboarding/cohort-curator.ts`; statement text, ordering, and
// transaction membership preserved — these compose inside the caller's
// transactions exactly as the inline SQL did) ──────────────────────────────

/**
 * Rebind freeze-persisted snapshot refs onto a reused child run (idempotent
 * in-place update inside the caller's transaction). Used both when a prior
 * refs-bearing child exists under the same parent and when backfilling refs
 * on a side-effect-free member run during resume.
 */
export function rebindMemberChildSnapshotRefs(
  childRunId: string,
  configSnapshotId: string,
  configSnapshotHash: string,
): void {
  getDb().run(
    'UPDATE classification_runs SET config_snapshot_id = ?, config_snapshot_hash = ? WHERE id = ?',
    [configSnapshotId, configSnapshotHash, childRunId],
  );
}

/**
 * Snapshot hash of the FIRST committed child (ASC-first ordering is
 * load-bearing: all member snapshots freeze against the same config
 * authority — the earliest committed child carries the canonical Brand
 * authority for post-loop semantic coherence). Null when no committed child.
 */
export function getFirstCommittedMemberChildSnapshotHash(cohortRunId: string): string | null {
  const row = getDb().query(
    `SELECT config_snapshot_hash FROM classification_runs
     WHERE cohort_run_id = ? AND status IN ('completed', 'completed_with_abstentions')
     ORDER BY started_at ASC LIMIT 1`,
  ).get(cohortRunId) as { config_snapshot_hash: string | null } | undefined;
  return row?.config_snapshot_hash ?? null;
}

// ─── Freeze authorities (ownership-guarded) ───────────────────────────────────

export interface FreezeAuthorityFields {
  /** H2 — canonical hash over the frozen member evidence (mandatory). */
  evidenceSnapshotHash: string | null;
  /** Reference to the persisted classification_cohort_snapshots row (PR3 M2). */
  evidenceSnapshotId?: string | null;
  /** H3 — pure bundleHash authority (nullable mirror). */
  configSnapshotId?: string | null;
  configSnapshotHash?: string | null;
  /** H4 — Page catalog identity (nullable mirror). */
  pageImportId?: string | null;
  pageImportHash?: string | null;
  /** H5 — unbound model-execution digest (nullable mirror). */
  modelPolicyDigest?: string | null;
}

/**
 * Write the frozen authority hashes onto a `freezing` run. Ownership-guarded:
 * the UPDATE matches only when the run is still `freezing` AND claimed by
 * `workerId` — a stale owner can never freeze, a new owner can never freeze
 * another's run. No-op (false) otherwise.
 */
export function freezeCohortRunAuthorities(
  runId: string,
  workerId: string,
  fields: FreezeAuthorityFields,
): boolean {
  const result = getDb().run(
    `UPDATE classification_cohort_runs
     SET evidence_snapshot_hash = ?, evidence_snapshot_id = ?, config_snapshot_id = ?, config_snapshot_hash = ?,
         page_import_id = ?, page_import_hash = ?, model_policy_digest = ?
     WHERE id = ? AND claimed_by = ? AND status = 'freezing'`,
    [
      fields.evidenceSnapshotHash,
      fields.evidenceSnapshotId ?? null,
      fields.configSnapshotId ?? null,
      fields.configSnapshotHash ?? null,
      fields.pageImportId ?? null,
      fields.pageImportHash ?? null,
      fields.modelPolicyDigest ?? null,
      runId,
      workerId,
    ],
  );
  return result.changes > 0;
}

// ─── PR4 write-once primitives (issue #30 PR4 C2) ────────────────────────────

/**
 * Fields written when a cohort's family coherence RESOLVES to a Product Type
 * (PR4 architecture-report §2.3, DECISION-B: freeze-time write inside the
 * final CAS transaction). `coherent` and `coherent_with_abstentions` write
 * the id + confidence + outcome together; abstain/conflict use
 * `writeProductTypeOutcomeOnly` (id/confidence stay NULL by design).
 */
export interface ExecutionProductTypeFields {
  executionProductTypeId: string;
  productTypeConfidence: number;
  productTypeOutcome: 'coherent' | 'coherent_with_abstentions';
}

/**
 * Write the cohort-level Execution Product Type onto a `freezing` run.
 * Write-once CAS: the UPDATE matches ONLY when the run is still `freezing`
 * AND claimed by `workerId` AND ALL THREE semantic slots are still NULL —
 * `execution_product_type_id`, `product_type_confidence`, and
 * `product_type_outcome`. A second write (any slot already set — including a
 * prior abstain/conflict written via `writeProductTypeOutcomeOnly`), a stale
 * owner, or a run that already left `freezing` is a no-op (false). The
 * outcome-only guard closes the PR4 cross-path hole: a coherent write can
 * never overwrite a previously write-once abstained/conflicted outcome, and
 * vice versa. Modeled on `freezeCohortRunAuthorities`. No FK on
 * `execution_product_type_id` (product types are config/bundle-derived;
 * `target_id` precedent is FK-free).
 */
export function writeExecutionProductType(
  runId: string,
  workerId: string,
  fields: ExecutionProductTypeFields,
): boolean {
  const result = getDb().run(
    `UPDATE classification_cohort_runs
     SET execution_product_type_id = ?, product_type_confidence = ?, product_type_outcome = ?
     WHERE id = ? AND claimed_by = ? AND status = 'freezing'
       AND execution_product_type_id IS NULL
       AND product_type_confidence IS NULL
       AND product_type_outcome IS NULL`,
    [fields.executionProductTypeId, fields.productTypeConfidence, fields.productTypeOutcome, runId, workerId],
  );
  return result.changes > 0;
}

/**
 * Write the final membership hash onto a `freezing` run (PR4 §3). Written
 * ONCE in the same shared semantic commit as the Execution Type when family
 * coherence passes (coherent / coherent_with_abstentions / abstained — final
 * membership = candidate membership; a conflicted run writes nothing and
 * fails instead). Write-once CAS: only while `freezing`, claimed by
 * `workerId`, and `final_membership_hash` still NULL.
 */
export function writeFinalMembershipHash(runId: string, workerId: string, hash: string): boolean {
  const result = getDb().run(
    `UPDATE classification_cohort_runs
     SET final_membership_hash = ?
     WHERE id = ? AND claimed_by = ? AND status = 'freezing' AND final_membership_hash IS NULL`,
    [hash, runId, workerId],
  );
  return result.changes > 0;
}

/**
 * Write ONLY the `product_type_outcome` marker for abstain/conflict, where
 * `execution_product_type_id`/`product_type_confidence` stay NULL by design
 * (PR4 §2.4). Same write-once + ownership + status CAS guards as
 * `writeExecutionProductType`, with `product_type_outcome IS NULL` as the CAS
 * slot — an outcome is written exactly once and never overwritten.
 */
export function writeProductTypeOutcomeOnly(
  runId: string,
  workerId: string,
  outcome: Extract<ExecutionProductTypeOutcome, 'abstained' | 'conflicted'>,
): boolean {
  const result = getDb().run(
    `UPDATE classification_cohort_runs
     SET product_type_outcome = ?
     WHERE id = ? AND claimed_by = ? AND status = 'freezing' AND product_type_outcome IS NULL`,
    [outcome, runId, workerId],
  );
  return result.changes > 0;
}

// ─── Proposal dependency metadata (issue #30 PR4 C2) ─────────────────────────

/**
 * Insert ONE classification-proposal dependency row (schema v6). PR4 records
 * dependency METADATA only: when a member SKU run executes under a
 * coherent cohort Execution Product Type, the member's `field_assignment`
 * proposals are stamped with one row (`dependency_kind='execution_product_type'`,
 * `dependency_target_id` = the run's execution_product_type_id at proposal
 * creation, `dependency_value_hash` = hashCanonicalJson({executionProductTypeId,
 * productTypeConfidence}) — the future invalidation key, PR5+). PR5 hardening
 * (issue #30 P2) adds the reviewed-source kind: a member whose effective
 * Curation Product Type came from a reviewed Primary Product Type stamps its
 * `field_assignment` proposals with `dependency_kind='reviewed_product_type'`,
 * `dependency_target_id` = the reviewed type id, `dependency_value_hash` =
 * hashCanonicalJson({reviewedProductTypeId}). ONLY `field_assignment` proposals
 * are stamped — `primary_product_type` / `category_page` proposals are not
 * downstream of the effective type. The kind is a free-form string here; the
 * unique (proposal_id, dependency_kind) index allows both kinds to coexist
 * on one proposal.
 *
 * IDEMPOTENT (PR4 review fix): `(proposal_id, dependency_kind)` is unique
 * (`idx_classification_proposal_dependencies_unique`, schema v6), and the
 * insert is a check-then-insert in the caller's transaction — a re-stamped
 * row (e.g. the member commit re-executing after a crash-recovery resume
 * re-stamps a proposal row persisted by a pre-crash attempt) returns the
 * EXISTING row id without a second row. The existing-row fast path RELOADS
 * the full row and requires workspace, target, and hash equality before
 * reusing it; any mismatch FAILS CLOSED (throws) rather than silently
 * blessing a proposal stamped under a different execution type / workspace
 * — the unique index forbids a second row anyway, so 'insert the new row'
 * would only surface a confusing UNIQUE error. The unique index is the
 * DB-level backstop for a concurrent duplicate insert (fails closed via
 * UNIQUE rather than ever creating two rows). Workspace-scoped and FK
 * fail-closed: a NEW row with an unknown `proposalId`/`workspaceId` throws
 * a FOREIGN KEY constraint error.
 * Returns the (existing or newly inserted) row id.
 */
export function insertProposalDependency(input: {
  workspaceId: string;
  proposalId: string;
  dependencyKind: string;
  dependencyTargetId: string;
  dependencyValueHash: string;
}): string {
  const db = getDb();
  const existing = db.query(
    `SELECT id, workspace_id, dependency_target_id, dependency_value_hash
     FROM classification_proposal_dependencies
     WHERE proposal_id = ? AND dependency_kind = ?`,
  ).get(input.proposalId, input.dependencyKind) as
    | { id: string; workspace_id: string; dependency_target_id: string; dependency_value_hash: string }
    | undefined;
  if (existing) {
    if (
      existing.workspace_id !== input.workspaceId ||
      existing.dependency_target_id !== input.dependencyTargetId ||
      existing.dependency_value_hash !== input.dependencyValueHash
    ) {
      // Fail closed: a re-stamp under a DIFFERENT tuple is incoherent state
      // (the proposal's dependency metadata was stamped under another
      // execution type / workspace). Inserting a second row would violate the
      // unique index; reusing the row would silently record the wrong
      // invalidation key. Throw and roll the caller's transaction back.
      throw new Error(
        `Dependency row already exists for proposal ${input.proposalId} kind ${input.dependencyKind} ` +
          `with a different tuple (workspace ${existing.workspace_id}, target ${existing.dependency_target_id}); ` +
          `refusing to reuse it for workspace ${input.workspaceId}, target ${input.dependencyTargetId}.`,
      );
    }
    return existing.id;
  }
  const id = randomUUID();
  db.run(
    `INSERT INTO classification_proposal_dependencies
       (id, workspace_id, proposal_id, dependency_kind, dependency_target_id, dependency_value_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.workspaceId, input.proposalId, input.dependencyKind, input.dependencyTargetId, input.dependencyValueHash, now()],
  );
  return id;
}

/**
 * List dependency rows for a proposal (camelCase row shape), ordered by
 * created_at for stable presentation. Returns [] when the proposal has none.
 */
export function listDependenciesForProposal(proposalId: string): ProposalDependency[] {
  const rows = getDb().query(
    `SELECT id, workspace_id, proposal_id, dependency_kind, dependency_target_id, dependency_value_hash, created_at
     FROM classification_proposal_dependencies
     WHERE proposal_id = ?
     ORDER BY created_at ASC`,
  ).all(proposalId) as Record<string, any>[];
  return rows.map(row => ({
    id: row.id,
    workspaceId: row.workspace_id,
    proposalId: row.proposal_id,
    dependencyKind: row.dependency_kind,
    dependencyTargetId: row.dependency_target_id,
    dependencyValueHash: row.dependency_value_hash,
    createdAt: row.created_at,
  }));
}

// ─── Lifecycle transitions ────────────────────────────────────────────────────

/**
 * `freezing → running`: the ONLY path to execution. Ownership-guarded. Sets
 * `started_at` (execution start; NULL while freezing). Fails closed via the
 * schema CHECK if the two mandatory evidence hashes are still NULL.
 */
export function transitionCohortRunToRunning(runId: string, workerId: string): boolean {
  const result = getDb().run(
    `UPDATE classification_cohort_runs
     SET status = 'running', started_at = ?
     WHERE id = ? AND claimed_by = ? AND status = 'freezing'`,
    [now(), runId, workerId],
  );
  return result.changes > 0;
}

const COHORT_RUN_TERMINAL = [
  'completed',
  'completed_with_abstentions',
  'completed_with_member_failures',
  'failed',
  'cancelled',
  'superseded',
];

/**
 * Terminal write-once completion. A run already in a terminal state (or
 * superseded) is never overwritten. Sets `completed_at` and the optional
 * `error_message`.
 *
 * Owner-guard option (PR3 hardening, Commit A2): when `options.ownerGuard` is
 * provided the UPDATE is additionally CAS'd on `claimed_by = workerId` while
 * the run is still actively held (`status IN ('freezing','running')`) — a
 * stale worker can never write a terminal state onto a run another worker
 * reclaimed. The heartbeat-lost abort path never even attempts a terminal
 * write (the run already belongs to the reclaiming worker); this guard is the
 * defense-in-depth for every other terminal completion.
 */
export function completeCohortRun(
  runId: string,
  status: 'completed' | 'completed_with_abstentions' | 'completed_with_member_failures' | 'failed' | 'cancelled',
  errorMessage?: string,
  options?: { ownerGuard?: { workerId: string } },
): boolean {
  const placeholders = COHORT_RUN_TERMINAL.map(() => '?').join(', ');
  const where: string[] = ['id = ?', `status NOT IN (${placeholders})`];
  const params: (string | number | null)[] = [status, now(), errorMessage ?? null, runId, ...COHORT_RUN_TERMINAL];
  if (options?.ownerGuard) {
    where.push('claimed_by = ?', "status IN ('freezing','running')");
    params.push(options.ownerGuard.workerId);
  }
  const result = getDb().run(
    `UPDATE classification_cohort_runs
     SET status = ?, completed_at = ?, error_message = ?
     WHERE ${where.join(' AND ')}`,
    params,
  );
  return result.changes > 0;
}

/**
 * Supersede a run — settable from ANY state (including terminal ones), no
 * transition out of it. Historical rows keep their frozen values. Also fails
 * any linked RUNNING child classification_runs so
 * `idx_classification_runs_one_running_item` never blocks a member retry
 * under a new run (mirrors the stale-requeue / stale-run-cleanup contract).
 * The `reason` is recorded in `error_message` for traceability.
 */
export function supersedeCohortRun(runId: string, reason: string): boolean {
  const db = getDb();
  let changes = 0;
  db.transaction(() => {
    const result = db.run(
      `UPDATE classification_cohort_runs
       SET status = 'superseded', superseded_at = ?, error_message = ?
       WHERE id = ? AND status != 'superseded'`,
      [now(), reason ?? null, runId],
    );
    changes = result.changes;
    db.run(
      `UPDATE classification_runs
       SET status = 'failed', completed_at = ?, error_message = 'Superseded by cohort run supersession'
       WHERE cohort_run_id = ? AND status = 'running'`,
      [now(), runId],
    );
  })();
  return changes > 0;
}

/**
 * Cancel a run still in `freezing` (e.g. a freeze that can never finalize).
 * Terminal `cancelled` + `completed_at` + reason. No-op (false) once the run
 * has left `freezing`.
 */
export function cancelFreezingRun(runId: string, reason?: string): boolean {
  const result = getDb().run(
    `UPDATE classification_cohort_runs
     SET status = 'cancelled', completed_at = ?, error_message = ?
     WHERE id = ? AND status = 'freezing'`,
    [now(), reason ?? null, runId],
  );
  return result.changes > 0;
}

/**
 * Direct `freezing → failed` for a conflicted cohort (issue #30 PR4 re-review,
 * P1-2). A conflicted family NEVER passes through `running`: the parent is
 * failed IN PLACE (started_at stays NULL — the status guard below guarantees
 * no `freezing → running` transition ever happened), and every freeze-created
 * child `classification_runs` row of this parent that is still `running` is
 * atomically terminalized in the SAME transaction (mirrors the child cleanup
 * in `supersedeCohortRun`/`supersedeCohortRunIfUnchanged`, keyed on the
 * children's `cohort_run_id` linkage). The child reason is the deterministic
 * constant so a retry/reclaim can distinguish a conflict-blocked child from
 * a drift/supersession failure.
 *
 * One owner-guarded CAS transaction: the parent UPDATE matches ONLY while the
 * run is STILL `freezing` AND claimed by `workerId`. If the CAS fails
 * (ownership lost to a reclaiming sibling, or the run already left
 * `freezing`), the WHOLE transaction is a no-op — no parent write, no child
 * writes — and the caller treats it as ownership loss. `changes === 0` ⇒
 * nothing was touched.
 */
export function failFrozenCohortRunForConflict(
  runId: string,
  workerId: string,
  reason: string,
): boolean {
  const db = getDb();
  let changes = 0;
  db.transaction(() => {
    const result = db.run(
      `UPDATE classification_cohort_runs
       SET status = 'failed', completed_at = ?, error_message = ?
       WHERE id = ? AND claimed_by = ? AND status = 'freezing'`,
      [now(), reason ?? null, runId, workerId],
    );
    changes = result.changes;
    if (changes > 0) {
      db.run(
        `UPDATE classification_runs
         SET status = 'failed', completed_at = ?, error_message = 'Cohort Product Type conflict prevented member execution'
         WHERE cohort_run_id = ? AND status = 'running'`,
        [now(), runId],
      );
    }
  })();
  return changes > 0;
}

/**
 * Owner-guarded SUPERSEDE for output-authority drift (issue #30, PR6
 * hardening E). A committed `classification_cohort_outputs` set is WRITE-ONCE:
 * when the frozen title authority no longer matches it (or a commit-race
 * occurred), the run's decision is HISTORICAL and must not be redefined — the
 * parent is superseded (NOT failed) so `claimReadyCurationCohorts` can
 * immediately create a NEW revision, and every freeze-created running child
 * is terminalized in the same transaction (mirrors
 * `failFrozenCohortRunForConflict`). Parent CAS failure ⇒ ownership loss ⇒
 * whole transaction no-ops and no child is touched.
 */
export function supersedeOwnedCohortRunForOutputDrift(
  runId: string,
  workerId: string,
  reason: string,
): boolean {
  const db = getDb();
  let changes = 0;
  db.transaction(() => {
    const result = db.run(
      `UPDATE classification_cohort_runs
       SET status = 'superseded', superseded_at = ?, error_message = ?
       WHERE id = ? AND claimed_by = ? AND status = 'running'`,
      [now(), reason ?? null, runId, workerId],
    );
    changes = result.changes;
    if (changes > 0) {
      db.run(
        `UPDATE classification_runs
         SET status = 'failed', completed_at = ?, error_message = 'Cohort output authority drift superseded parent run'
         WHERE cohort_run_id = ? AND status = 'running'`,
        [now(), runId],
      );
    }
  })();
  return changes > 0;
}


/**
 * Fail-closed re-run conflict (PR10 review R1): the idle parent CAS failed
 * inside `rerunIdleCohortRevision` (superseded/claimed concurrently) — the
 * whole transaction rolled back and the caller should surface `run_busy`.
 */
export class CohortRerunBusyError extends Error {
  readonly runId: string;

  constructor(runId: string) {
    super(
      `[CohortRerunBusy] Cohort run ${runId} could not be superseded for a new revision; ` +
        'it may have been superseded or claimed concurrently (zero mutation).',
    );
    this.name = 'CohortRerunBusyError';
    this.runId = runId;
  }
}

/**
 * Fail-closed re-run stage conflict (PR10 review R1): a cohort member is in a
 * stage the re-run contract does not cover (anything outside review/curation,
 * e.g. promotion) — the whole request fails BEFORE any mutation rather than
 * silently skipping the member or destroying its downstream state.
 */
export class CohortRerunStageConflictError extends Error {
  readonly memberItemId: string;
  readonly stage: string;

  constructor(memberItemId: string, stage: string) {
    super(
      `[CohortRerunStageConflict] Cohort member ${memberItemId} is in stage "${stage}"; ` +
        'a new cohort revision is only valid while every member is in review/curation ' +
        '(zero mutation).',
    );
    this.name = 'CohortRerunStageConflictError';
    this.memberItemId = memberItemId;
    this.stage = stage;
  }
}

/**
 * Reviewer re-run as ONE cohort-atomic operation (PR10 review R1). Replaces
 * the previous two-transaction route (supersede + separate batch-wide item
 * reset), which (a) reset the whole BATCH instead of the exact cohort
 * membership and (b) committed the parent supersede BEFORE the reset, opening
 * the claim slot to a worker between the transactions.
 *
 * ONE `db.transaction` — the claim slot becomes externally visible ONLY when
 * the member reset becomes visible:
 *   1. validate EVERY cohort member is in review/curation (a member anywhere
 *      else => `CohortRerunStageConflictError`, full rollback, zero mutation);
 *   2. CAS the idle parent (`status != 'superseded'` AND not actively held)
 *      => `superseded`; CAS failure => `CohortRerunBusyError`, full rollback;
 *   3. terminalize linked running children (no-op for a terminal parent);
 *   4. reset the EXACT `curation_cohort_members` item ids to
 *      curation/pending with `curation_data_json` + claim fields cleared.
 *
 * `hooks?.afterParentSupersede` is a test-only seam (the established
 * `afterCoordinatedCall` pattern) proving atomic rollback of the CAS.
 */
export function rerunIdleCohortRevision(
  cohortId: string,
  currentRunId: string,
  reason: string,
  hooks?: { afterParentSupersede?: () => void },
): { superseded: boolean; resetMemberCount: number } {
  const db = getDb();
  let superseded = false;
  let resetMemberCount = 0;
  db.transaction(() => {
    // 1. Exact-membership stage validation (fail closed BEFORE the CAS).
    const members = db.query(
      'SELECT onboarding_item_id, stage FROM curation_cohort_members m ' +
        'JOIN onboarding_items i ON i.id = m.onboarding_item_id ' +
        'WHERE m.cohort_id = ?',
    ).all(cohortId) as Array<{ onboarding_item_id: string; stage: string }>;
    for (const member of members) {
      // Slice 5a bridge: canonical stage comparison (dual read) — v1
      // `review`/`curation` and v2 `review_listings`/`prepare_listing`
      // are the same semantic stages.
      let canonical: string;
      try {
        canonical = toCanonicalStored(member.stage);
      } catch {
        throw new CohortRerunStageConflictError(member.onboarding_item_id, member.stage);
      }
      if (canonical !== 'review_listings' && canonical !== 'prepare_listing') {
        throw new CohortRerunStageConflictError(member.onboarding_item_id, member.stage);
      }
    }
    // 2. Idle-parent CAS (the concurrency guard). SELF-AUTHENTICATING: the
    // CAS binds the parent to BOTH arguments (id + cohort_id) — a mismatched
    // (cohortId, currentRunId) pair can never supersede a run of another
    // cohort (PR10-close P2 hardening).
    const result = db.run(
      `UPDATE classification_cohort_runs
       SET status = 'superseded', superseded_at = ?, error_message = ?
       WHERE id = ? AND cohort_id = ?
         AND status != 'superseded'
         AND (status NOT IN ('freezing','running') OR claimed_by IS NULL)`,
      [now(), reason ?? null, currentRunId, cohortId],
    );
    if (result.changes === 0) {
      throw new CohortRerunBusyError(currentRunId);
    }
    superseded = true;
    hooks?.afterParentSupersede?.();
    // 3. Terminalize linked running children (no-op for a terminal parent).
    db.run(
      `UPDATE classification_runs
       SET status = 'failed', completed_at = ?, error_message = 'Cohort output authority drift superseded parent run'
       WHERE cohort_run_id = ? AND status = 'running'`,
      [now(), currentRunId],
    );
    // 4. Reset the EXACT cohort members (never the whole batch).
    // Slice 5a bridge: per-transaction storage-version read; the curation
    // reset write encodes the observed version (never a hardcoded spelling).
    const rerunVersion = readStorageVersion(db);
    const rerunStage = encodeForStorage('prepare_listing', rerunVersion);
    for (const member of members) {
      db.run(
        `UPDATE onboarding_items
         SET stage = ?, stage_status = 'pending', curation_data_json = NULL,
             claimed_by = NULL, claimed_at = NULL, updated_at = ?
         WHERE id = ?`,
        [rerunStage, now(), member.onboarding_item_id],
      );
      resetMemberCount++;
    }
  })();
  return { superseded, resetMemberCount };
}

// ─── Heartbeat (lease renewal) ──────────────────────────────────────────────────

/**
 * Renew a cohort run's claim lease. Ownership-guarded: only the run's current
 * `claimed_by` worker may heartbeat, and only while the run is still
 * `freezing` or `running` — a terminal run is never heartbeated. PR3 M3
 * `processCohort` piggybacks the heartbeat on member boundaries (before/after
 * each member, contract A), so a multi-SKU execution stays inside its TTL.
 * Returns false when the run is no longer ours to renew (a sibling worker
 * reclaimed it, or it went terminal/superseded).
 */
export function heartbeatCohortRun(runId: string, workerId: string, leaseTtlMs: number): boolean {
  const leaseExpiresAt = new Date(Date.now() + leaseTtlMs).toISOString();
  const result = getDb().run(
    `UPDATE classification_cohort_runs
     SET lease_expires_at = ?
     WHERE id = ? AND claimed_by = ? AND status IN ('freezing','running')`,
    [leaseExpiresAt, runId, workerId],
  );
  return result.changes > 0;
}

/**
 * PR9 review R1 (B2/B7): cohort-atomic, owner-guarded post-loop semantic
 * update. ALL affected members' `curation_data_json` writes happen in ONE
 * transaction whose FIRST statement is the parent cohort run's lease/
 * ownership CAS — the EXACT heartbeat predicate (`claimed_by = ? AND status
 * IN ('freezing','running')`). A rejected CAS (`changes === 0`) throws
 * `HeartbeatLostError` and the WHOLE transaction rolls back: a stale owner
 * (claim reclaimed by a sibling) can never write member items after
 * ownership moved, and a crash mid-loop can never persist a subset of the
 * cohort's Brand blocking. `updates` carries the already-merged FINAL
 * curation JSON per affected member (the caller reads each member once and
 * merges its findings before calling).
 */
export function writeCohortBrandSemanticUpdates(
  runId: string,
  workerId: string,
  leaseTtlMs: number,
  updates: Array<{ itemId: string; curationDataJson: string }>,
): void {
  const db = getDb();
  db.transaction(() => {
    const leaseExpiresAt = new Date(Date.now() + leaseTtlMs).toISOString();
    const result = db.run(
      `UPDATE classification_cohort_runs
       SET lease_expires_at = ?
       WHERE id = ? AND claimed_by = ? AND status IN ('freezing','running')`,
      [leaseExpiresAt, runId, workerId],
    );
    if (result.changes === 0) {
      throw new HeartbeatLostError(
        `processCohort lost claim ownership of run ${runId} during post-loop semantic updates ` +
          `(run is no longer claimed by ${workerId} / no longer freezing or running); no member ` +
          'curation-data update was applied.',
      );
    }
    const updatedAt = now();
    const updateStmt = db.query(
      'UPDATE onboarding_items SET curation_data_json = ?, updated_at = ? WHERE id = ?',
    );
    for (const update of updates) {
      updateStmt.run(update.curationDataJson, updatedAt, update.itemId);
    }
  })();
}

// ─── Reclaim (lease expiry) ───────────────────────────────────────────────────

export interface CohortRunReclaimResult {
  /** Runs whose expired lease was resumed: same run id, new worker, fresh lease. */
  resumed: CohortRun[];
  /** Runs superseded because their frozen authorities no longer match current state. */
  superseded: CohortRun[];
}

/**
 * Reclaim cohort runs whose lease has expired.
 *
 * - `verifyFrozen(run) === 'match'` → RESUME the same run: reassign to
 *   `workerId`, refresh `claimed_at`/`lease_expires_at`, keep the run id
 *   (re-freeze allowed — a crash mid-freeze leaves NULL hashes, which the
 *   production verifier treats as a vacuous match).
 * - `verifyFrozen(run) === 'drift'` → SUPERSEDE the run (and fail its linked
 *   running children); the cohort stays `ready` and the next claim creates a
 *   NEW run against fresh frozen authorities.
 *
 * `verifyFrozen` is injected so the repo stays pure SQL and tests can
 * deterministically force match/drift verdicts.
 *
 * `nowIso` is the caller's NOW (`new Date().toISOString()`): expiry timestamps
 * compare to now, so a lease is reclaimable the moment `lease_expires_at`
 * passes `now` — never only after a full extra TTL has elapsed.
 */
export function reclaimExpiredCohortRuns(
  workspaceId: string,
  nowIso: string,
  verifyFrozen: (run: CohortRun) => 'match' | 'drift',
  workerId: string,
  leaseTtlMs: number,
): CohortRunReclaimResult {
  const db = getDb();
  const leaseExpiresAt = new Date(Date.now() + leaseTtlMs).toISOString();
  const expired = db.query(
    `SELECT * FROM classification_cohort_runs
     WHERE workspace_id = ? AND status IN ('freezing','running')
       AND (lease_expires_at IS NULL OR lease_expires_at < ?)
     ORDER BY created_at ASC`,
  ).all(workspaceId, nowIso) as Record<string, any>[];

  const resumed: CohortRun[] = [];
  const superseded: CohortRun[] = [];
  for (const row of expired) {
    const run = mapCohortRunRow(row);
    if (verifyFrozen(run) === 'match') {
      // RESUME is a CAS on the state observed at SELECT time: reassign the
      // worker and refresh the lease ONLY when the row is unchanged since
      // selection — including its EXACT observed status (Commit A2). changes
      // === 0 ⇒ a sibling worker already resumed (or the run left the
      // observed state, e.g. it was finalized freezing → running in place)
      // ⇒ this run is NEVER handed out twice.
      const updated = db.run(
        `UPDATE classification_cohort_runs
         SET claimed_by = ?, claimed_at = ?, lease_expires_at = ?
         WHERE id = ? AND status = ?
           AND claimed_by IS ? AND lease_expires_at IS ?`,
        [workerId, nowIso, leaseExpiresAt, run.id, run.status, run.claimedBy, run.leaseExpiresAt],
      );
      if (updated.changes > 0) {
        const resumedRow = getCohortRunById(run.id);
        if (resumedRow) resumed.push(resumedRow);
      }
    } else {
      // Drift verdict is ONLY applied via the observed-state CAS: a stale
      // drift verdict (row already resumed by another worker) must never
      // supersede that worker's fresh claim.
      const supersededOk = supersedeCohortRunIfUnchanged(
        run.id,
        { claimedBy: run.claimedBy, leaseExpiresAt: run.leaseExpiresAt, status: run.status },
        'Authority drift during lease reclaim',
      );
      if (supersededOk) {
        const supersededRow = getCohortRunById(run.id);
        if (supersededRow) superseded.push(supersededRow);
      }
    }
  }
  return { resumed, superseded };
}

/**
 * CAS-guarded supersession. Supersedes the run ONLY when it still matches the
 * `observed` state (owner, lease expiry, status) captured at selection time —
 * `changes > 0` only then. On success the linked RUNNING child classification
 * runs are failed so `idx_classification_runs_one_running_item` never blocks a
 * member retry under a new run (mirrors `supersedeCohortRun`). Returns false
 * when the row changed since selection (never hand out / never supersede).
 * The reclaim drift branch uses ONLY this function.
 */
export function supersedeCohortRunIfUnchanged(
  runId: string,
  observed: { claimedBy: string | null; leaseExpiresAt: string | null; status: string },
  reason: string,
): boolean {
  const db = getDb();
  let changes = 0;
  db.transaction(() => {
    const result = db.run(
      `UPDATE classification_cohort_runs
       SET status = 'superseded', superseded_at = ?, error_message = ?
       WHERE id = ? AND claimed_by IS ? AND lease_expires_at IS ? AND status = ?`,
      [now(), reason ?? null, runId, observed.claimedBy, observed.leaseExpiresAt, observed.status],
    );
    changes = result.changes;
    if (changes > 0) {
      db.run(
        `UPDATE classification_runs
         SET status = 'failed', completed_at = ?, error_message = 'Superseded by cohort run supersession'
         WHERE cohort_run_id = ? AND status = 'running'`,
        [now(), runId],
      );
    }
  })();
  return changes > 0;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * The CURRENT run for a cohort — the DB invariant: at most one row with
 * `status != 'superseded'` (enforced by
 * `idx_classification_cohort_runs_current`). A completed/failed run REMAINS
 * the current historical decision until something explicitly supersedes it.
 */
export function getCurrentCohortRun(cohortId: string): CohortRun | null {
  const row = getDb().query(
    `SELECT * FROM classification_cohort_runs
     WHERE cohort_id = ? AND status != 'superseded'
     ORDER BY created_at DESC LIMIT 1`,
  ).get(cohortId) as Record<string, any> | undefined;
  return row ? mapCohortRunRow(row) : null;
}

export function getCohortRunById(id: string): CohortRun | null {
  const row = getDb().query(
    'SELECT * FROM classification_cohort_runs WHERE id = ?',
  ).get(id) as Record<string, any> | undefined;
  return row ? mapCohortRunRow(row) : null;
}

/**
 * The LATEST superseded run for a cohort (PR13 C2, issue #30) — the
 * cross-parent title-reuse candidate: `SELECT ... WHERE cohort_id = ? AND
 * status = 'superseded' ORDER BY superseded_at DESC, id DESC LIMIT 1` (the
 * `id DESC` secondary tiebreaker makes an exact `superseded_at` timestamp
 * tie deterministic — PR13 review R2 P2). A superseded
 * parent's committed output rows are immutable historical truth; the title
 * coordinator may COPY them into a NEW revision when the frozen title
 * authority is byte-identical (T-hash match) — zero LLM calls. Returns null
 * when the cohort has no superseded run.
 */
export function getLatestSupersededRunForCohort(cohortId: string): CohortRun | null {
  const row = getDb().query(
    `SELECT * FROM classification_cohort_runs
     WHERE cohort_id = ? AND status = 'superseded'
     ORDER BY superseded_at DESC, id DESC LIMIT 1`,
  ).get(cohortId) as Record<string, any> | undefined;
  return row ? mapCohortRunRow(row) : null;
}

export function listCohortRunsByCohort(cohortId: string): CohortRun[] {
  const rows = getDb().query(
    `SELECT * FROM classification_cohort_runs
     WHERE cohort_id = ? ORDER BY created_at ASC`,
  ).all(cohortId) as Record<string, any>[];
  return rows.map(mapCohortRunRow);
}

// ─── Execution-evidence snapshots (PR3 M2) ────────────────────────────────────

/**
 * Persist a content-addressed execution-evidence snapshot. `UNIQUE
 * (workspace_id, snapshot_hash)` dedupes identical payloads to the same row
 * (an INSERT race loser retries the lookup). Returns the row id + hash.
 */
export function persistCohortSnapshot(input: {
  workspaceId: string;
  /** H2 digest over the payload (content-addressed identity). */
  snapshotHash: string;
  projectionVersion: string;
  payloadJson: string;
}): { id: string; hash: string } {
  const db = getDb();
  const existing = db.query(
    'SELECT id FROM classification_cohort_snapshots WHERE workspace_id = ? AND snapshot_hash = ?',
  ).get(input.workspaceId, input.snapshotHash) as { id: string } | undefined;
  if (existing) return { id: existing.id, hash: input.snapshotHash };

  const id = randomUUID();
  try {
    db.run(
      `INSERT INTO classification_cohort_snapshots
       (id, workspace_id, snapshot_hash, snapshot_kind, projection_version, payload_json, created_at)
       VALUES (?, ?, ?, 'evidence', ?, ?, ?)`,
      [id, input.workspaceId, input.snapshotHash, input.projectionVersion, input.payloadJson, now()],
    );
  } catch (err) {
    // UNIQUE race loser against (workspace_id, snapshot_hash): the row exists.
    const isUniqueRace = err instanceof Error && err.message.includes('UNIQUE constraint failed');
    if (!isUniqueRace) throw err;
  }
  const stored = getCohortSnapshotByHash(input.workspaceId, input.snapshotHash);
  if (!stored) {
    throw new Error('Execution-evidence snapshot persistence failed: no stored row.');
  }
  return { id: stored.id, hash: stored.snapshotHash };
}

/** Look up a persisted execution-evidence snapshot by its content hash. */
export function getCohortSnapshotByHash(
  workspaceId: string,
  snapshotHash: string,
): { id: string; snapshotHash: string; payloadJson: string } | null {
  const row = getDb().query(
    'SELECT id, snapshot_hash, payload_json FROM classification_cohort_snapshots WHERE workspace_id = ? AND snapshot_hash = ?',
  ).get(workspaceId, snapshotHash) as { id: string; snapshot_hash: string; payload_json: string } | undefined;
  if (!row) return null;
  return { id: row.id, snapshotHash: row.snapshot_hash, payloadJson: row.payload_json };
}
