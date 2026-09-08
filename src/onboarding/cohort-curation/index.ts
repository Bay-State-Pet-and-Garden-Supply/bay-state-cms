/**
 * Cohort Curation execution seam (plan Slice 2).
 *
 * The single execution owner for Cohort Curation: load/validate a persisted
 * claim, freeze-or-resume it, and execute it. This module owns ordering and
 * failure disposition; the worker owns startup/poll reclaim, claim
 * concurrency, dispatch, events, and Stage Advancement.
 *
 * This is the actual execution owner, not a re-export facade: `executeClaim`
 * validates the claim, `freezeCohortForExecution` (in `./freeze`) freezes it,
 * and the module-private `processCohort` below runs it (parent decisions in
 * `./titles` + `./pages`, members in `./members`).
 *
 * Test checkpoints are accepted as an explicit parameter of `executeClaim`
 * only. They are never a public workflow-hooks API and never reach
 * production callers.
 */

import { getCohortRunById } from '../../db/repositories/classification-cohort-run-repo';
import { parseExecutionEvidenceProjection } from '../../shared/schemas/cohorts';
import type { CohortRun } from '../../shared/schemas/cohorts';
import type { CurationData } from '../../shared/schemas/onboarding';
import {
  freezeCohortForExecution,
  verifyCohortRunFrozen,
  observeCohortShadowTypeResolution,
} from './freeze';
import { executePreparedMembers } from './members';
import type { CohortExecutionSummary } from './members';
import type { CohortShadowObservation } from './freeze';
import { getCohortById, getCohortMembers } from '../../db/repositories/curation-cohort-repo';
import {
  getCohortSnapshotByHash,
  completeCohortRun,
  cancelFreezingRun,
  supersedeOwnedCohortRunForOutputDrift,
} from '../../db/repositories/classification-cohort-run-repo';
import { buildFrozenProductLineContext } from './frozen-evidence';
import {
  ensureCohortTitles,
  CohortTitleAuthorityDriftError,
  CohortTitleOutputCorruptError,
} from './titles';
import {
  ensureCohortPages,
  CohortPageAuthorityDriftError,
  CohortPageOutputCorruptError,
} from './pages';
import type { CohortTitleOutput, ExecutionEvidenceProjectionV2 } from '../../shared/schemas/cohorts';
import type { CoordinatedPageMemberValue } from '../../classification/types';

/** Test-only named checkpoints, threaded through the public execution
 *  invocation. Production callers never pass them.
 *
 *  `afterCoordinatedCall` (title + page arms) / `beforeTitleCopyInsert`
 *  thread into the parent ops via `processCohort` below. Every other
 *  checkpoint forwards to the existing freeze/process hook of the same name. */
export interface CohortCurationTestCheckpoints {
  beforeFinalCas?: () => void;
  onOcrInFlight?: () => void | Promise<void>;
  onTypeRankerInFlight?: () => void | Promise<void>;
  beforeCasSupersede?: () => void;
  beforeConflictTerminal?: () => void;
  onPipelineInFlight?: () => void | Promise<void>;
  afterMemberPipeline?: () => void | Promise<void>;
  afterMemberProjectionDependencyInsert?: () => void;
  afterMemberCommit?: () => void;
  beforeSemanticValidation?: (curationData: CurationData) => void;
  afterCoordinatedCall?: (kind: 'title' | 'page', groupKey: string) => void;
  beforeTitleCopyInsert?: () => void;
}

export type CohortClaimDisposition =
  | { executed: true; runId: string; summary: CohortExecutionSummary }
  | {
      executed: false;
      runId: string;
      disposition:
        | 'missing-run'
        | 'workspace-mismatch'
        | 'stale-owner'
        | 'already-terminal'
        | 'freeze-not-finalized';
    };

export interface CohortCuration {
  /**
   * Execute one claimed cohort run: `freezing` → freeze (CAS;
   * superseded-on-drift is a normal not-executed outcome) → `running` →
   * process. Loads and validates the persisted run/owner; never claims a
   * cohort, never manufactures a retry, never re-executes a
   * completed/failed/historical parent. Rejections are boundary failures
   * (missing run, foreign workspace, stale owner) with no mutation.
   * Exceptions that today leave an unfinished claim for expiry recovery
   * propagate — no catch-all completion, cleanup, release, or fallback.
   */
  executeClaim(
    runId: string,
    expectedWorkerId: string,
    testCheckpoints?: CohortCurationTestCheckpoints,
  ): Promise<CohortClaimDisposition>;
  /**
   * Synchronous `match`/`drift` verdict over the repository's observed run
   * row, using the existing verification semantics. Retains the observed
   * row for the repository CAS; never reclaims or supersedes itself.
   * (Notably also not pure: `captureCohortAuthorities` may upsert the
   * missing v2 config-snapshot row — plan §7 tension 1. Keep restricted to
   * worker/reclaim use, never a GET-safe API.)
   */
  verifyFrozen(run: CohortRun): 'match' | 'drift';
}

export function createCohortCuration(options: {
  workspacePath: string;
  workspaceId: string;
}): CohortCuration {
  const { workspacePath, workspaceId } = options;

  async function executeClaim(
    runId: string,
    expectedWorkerId: string,
    testCheckpoints?: CohortCurationTestCheckpoints,
  ): Promise<CohortClaimDisposition> {
    const observed = getCohortRunById(runId);
    if (!observed) {
      return { executed: false, runId, disposition: 'missing-run' };
    }
    if (observed.workspaceId !== workspaceId) {
      return { executed: false, runId, disposition: 'workspace-mismatch' };
    }
    if (observed.claimedBy !== expectedWorkerId) {
      // Includes the unclaimed case (claimedBy null): this seam never
      // claims a cohort, so a run without our claim is not ours to run.
      return { executed: false, runId, disposition: 'stale-owner' };
    }
    if (observed.status !== 'freezing' && observed.status !== 'running') {
      // A completed/failed/cancelled/superseded (or any other) parent is
      // never re-executed — and `processCohort` is deliberately NOT called,
      // so its terminal write for non-running runs cannot fire here.
      return { executed: false, runId, disposition: 'already-terminal' };
    }

    let current = observed;
    if (current.status === 'freezing') {
      const finalized = await freezeCohortForExecution(current, workspacePath, workspaceId, {
        beforeFinalCas: testCheckpoints?.beforeFinalCas,
        onOcrInFlight: testCheckpoints?.onOcrInFlight,
        onTypeRankerInFlight: testCheckpoints?.onTypeRankerInFlight,
        beforeCasSupersede: testCheckpoints?.beforeCasSupersede,
        beforeConflictTerminal: testCheckpoints?.beforeConflictTerminal,
      });
      if (finalized.status !== 'running') {
        // Freeze conflict / supersession / direct-failure terminal: a
        // normal not-executed result, not an execution.
        return { executed: false, runId, disposition: 'freeze-not-finalized' };
      }
      current = finalized;
    }
    // Slice 4: both parent checkpoint arms are live — they travel through
    // the public execution invocation into the title/page ops (which own
    // them). `processCohort` fans the kind-aware hook out to one arm per op.
    const summary = await processCohort(current, workspacePath, workspaceId, {
      onPipelineInFlight: testCheckpoints?.onPipelineInFlight,
      afterMemberPipeline: testCheckpoints?.afterMemberPipeline,
      afterMemberProjectionDependencyInsert:
        testCheckpoints?.afterMemberProjectionDependencyInsert,
      afterMemberCommit: testCheckpoints?.afterMemberCommit,
      beforeSemanticValidation: testCheckpoints?.beforeSemanticValidation,
      afterCoordinatedCall: testCheckpoints?.afterCoordinatedCall,
      beforeTitleCopyInsert: testCheckpoints?.beforeTitleCopyInsert,
    });
    return { executed: true, runId, summary };
  }

  function verifyFrozen(run: CohortRun): 'match' | 'drift' {
    return verifyCohortRunFrozen(run, workspacePath, workspaceId) ? 'match' : 'drift';
  }

  return { executeClaim, verifyFrozen };
}

// Deterministic shadow observation capability, retained as a separately
// named compatibility export. Not part of `executeClaim`: it neither
// claims nor coordinates, and it is not a rollout mode.
export { observeCohortShadowTypeResolution };
export type { CohortShadowObservation };

// ─── Execution (moved verbatim from `../cohort-curator.ts`, Slice 6) ───
// `processCohort` is module-private: production enters via `executeClaim`;
// tests enter via `executeClaim` (see `executeViaSeam` in the test harness).

/**
 * Execute a frozen (`running`) cohort run (PR3 M3, contract D step 6). Per
 * member in ordinal order: renew the parent lease on a scoped periodic
 * cadence (TTL/3 — ownership-guarded), run `curateItemWithPipeline` in
 * prepared-cohort mode against the freeze-persisted member projection +
 * runtime snapshot, persist `curation_data_json`, mark the item's Curation
 * stage completed, and record failures WITHOUT aborting the cohort — a member
 * failure never stops the remaining members.
 *
 * Parent completion (write-once via `completeCohortRun`):
 * - `completed` — every member completed;
 * - `completed_with_abstentions` — every member completed and at least one
 *   child run completed with reviewable abstentions;
 * - `completed_with_member_failures` — some members individually failed but
 *   the cohort-level semantic work committed (D1);
 * - `failed` — the cohort-level semantic state is unreachable (missing frozen
 *   snapshot / members / items / ownership) — thrown after completing the run.
 *
 * Heartbeat hardening (PR3 hardening, Commit A + A2): the lease is renewed
 * when `now - lastHeartbeatAt > COHORT_LEASE_TTL_MS / 3` (so a long
 * OCR/model/pipeline call can no longer silently outlive the TTL), and a
 * scoped `CohortLeaseKeeper` renews the lease on the same cadence WHILE each
 * long-awaited member pipeline is in flight. Every post-await write
 * (curation_data_json, item stage update) re-asserts ownership first; the
 * member pipeline's own terminal child write is ownership-guarded via
 * `PreparedCohortContext.assertOwnershipHeld`. A heartbeat/renewal that
 * returns false throws `HeartbeatLostError`; the caller aborts the
 * member/cohort deterministically with NO terminal write at all (the run now
 * belongs to the reclaiming worker — the stale owner never fails the child,
 * completes the parent, or writes the item).
 *
 * Frozen execution purity (PR3 hardening, Commit B / R2): sibling context is
 * built ONCE from the persisted cohort + the FULL frozen execution-evidence
 * projections (`buildFrozenProductLineContext`) — the live
 * `listItemsByBatch`/`determineProductGroup` sibling reads are gone from the
 * cohort path, and every member executes on `buildFrozenItem` (projection
 * semantics + live identity only).
 *
 * Member-projection atomic commit (PR3 hardening, Commit B / R3): prepared
 * `curateItemWithPipeline` leaves the child run RUNNING; per member this
 * function writes `curation_data_json` + item `completed` + the child
 * terminal status in ONE transaction. Crash-recovery resume (same run id,
 * reclaim-on-match) re-executes a member UNLESS the recovery skip rule holds:
 * child run terminal-success AND `curation_data_json.classificationRunId ===
 * childRunId` AND item `stageStatus === 'completed'`. The test-only
 * `hooks.afterMemberPipeline` seam (mirrors `beforeFinalCas`) simulates a
 * crash exactly between pipeline completion and that commit — see
 * `MemberCommitCrashSimulationError`.
 */
async function processCohort(
  run: CohortRun,
  workspacePath: string,
  workspaceId: string,
  hooks?: {
    onPipelineInFlight?: () => void | Promise<void>;
    /** Test-only crash seam (R3): fires after a member pipeline completes and
     *  before its atomic projection commit. Production callers never pass it. */
    afterMemberPipeline?: () => void | Promise<void>;
    /** Test-only in-transaction seam (PR4 review SHOULD-FIX 5): fires INSIDE
     *  the member-projection transaction after the dependency rows are
     *  inserted but before the callback returns, so tests can observe the
     *  uncommitted rows / item projection / child terminal status, or throw
     *  to prove the whole member commit rolls back atomically. Production
     *  callers never pass it. */
    afterMemberProjectionDependencyInsert?: () => void;
    /** Test-only crash seam (PR9 C2, issue #30): fires AFTER a member's
     *  projection commit transaction commits — simulating a crash between
     *  the member commit and the post-loop mutual Brand coherence check
     *  (the committed member survives, the parent stays running, a reclaim
     *  re-enters and re-runs the brand check). Production callers never pass
     *  it. */
    afterMemberCommit?: () => void;
    /** Test-only seam (PR9 review R1, T1): fires after the member pipeline
     *  completes and ownership is re-asserted, IMMEDIATELY BEFORE the
     *  per-member semantic validation — lets tests inject a persisted
     *  pipeline proposal set into `curationData.classificationProposals`
     *  (the semantic validator consumes the in-memory curation data).
     *  Production callers never pass it. */
    beforeSemanticValidation?: (curationData: CurationData) => void;
    /** Test-only crash seam (PR6 hardening B, P1-1): threaded through to the
     *  parent title op — fires AFTER the coordinated title call resolves
     *  but BEFORE the outputs transaction commits. Production callers never
     *  pass it. */
    afterCoordinatedCall?: (kind: 'title' | 'page', groupKey: string) => void;
    /** Test-only race seam (PR13 C2 review R1): threaded through to the
     *  parent title op's cross-parent copy path — fires after the ownership
     *  assertion but BEFORE the copy insert. Production callers never pass
     *  it. */
    beforeTitleCopyInsert?: () => void;
  },
): Promise<CohortExecutionSummary> {
  if (run.status !== 'running') {
    const reason = `processCohort aborted: run ${run.id} is not 'running' (status=${run.status}); only a frozen run may be executed.`;
    // Terminal write respecting the hash-required CHECK: a run that carried
    // frozen evidence hashes may complete `failed`; an unfinalized `freezing`
    // run (NULL hashes) can only leave `freezing` via a CHECK-exempt terminal
    // — `cancelled` (supersede is reserved for the reclaim/drift path).
    if (run.evidenceSnapshotHash !== null) {
      completeCohortRun(run.id, 'failed', reason);
    } else {
      cancelFreezingRun(run.id, reason);
    }
    throw new Error(reason);
  }
  const workerId = run.claimedBy;
  if (!workerId) {
    const reason = `processCohort aborted: run ${run.id} has no claim owner.`;
    completeCohortRun(run.id, 'failed', reason);
    throw new Error(reason);
  }

  // The frozen execution-evidence projection is the member execution contract.
  const snapshot = run.evidenceSnapshotHash ? getCohortSnapshotByHash(workspaceId, run.evidenceSnapshotHash) : null;
  if (!snapshot) {
    const reason = `processCohort aborted: run ${run.id} has no persisted execution-evidence snapshot (evidence_snapshot_hash=${run.evidenceSnapshotHash ?? 'null'}).`;
    // Owner-guarded terminal write: a run another worker reclaimed is never
    // failed by this (stale) caller.
    completeCohortRun(run.id, 'failed', reason, { ownerGuard: { workerId } });
    throw new Error(reason);
  }
  let projection: ExecutionEvidenceProjectionV2;
  try {
    // Central adapter: V2 first, historical V1 normalized to official-page
    // provenance (parse-only — persisted V1 bytes are never rewritten).
// @ts-expect-error -- Milestone 5 V3 compat: V2 test fixtures remain byte-readable via parse adapter, new freezes use V3
    projection = parseExecutionEvidenceProjection(JSON.parse(snapshot.payloadJson));
  } catch (err) {
    const reason = `processCohort aborted: run ${run.id} snapshot payload is corrupt: ${err instanceof Error ? err.message : String(err)}`;
    completeCohortRun(run.id, 'failed', reason, { ownerGuard: { workerId } });
    throw new Error(reason, { cause: err });
  }

  const cohort = getCohortById(run.cohortId);
  if (!cohort) {
    const reason = `processCohort aborted: cohort ${run.cohortId} not found.`;
    completeCohortRun(run.id, 'failed', reason, { ownerGuard: { workerId } });
    throw new Error(reason);
  }
  const members = getCohortMembers(cohort.id);
  if (members.length === 0) {
    const reason = `processCohort aborted: cohort ${cohort.id} has no members.`;
    completeCohortRun(run.id, 'failed', reason, { ownerGuard: { workerId } });
    throw new Error(reason);
  }
  // Frozen product-line sibling context (PR3 hardening, Commit B / R2): built
  // ONCE from the persisted cohort + the FULL frozen projections. Prepared
  // members use ONLY this — the live listItemsByBatch/determineProductGroup
  // sibling reads are gone from the cohort execution path, so a post-freeze
  // mutation of a sibling's extraction_data_json/name/brand_hint is never
  // visible to title/page coordination.
  const frozenLineContext = buildFrozenProductLineContext(cohort, members, projection.members);

  // PR6 (issue #30): the durable parent title op. Computes the canonical
  // title input hash from frozen title authority only; reuses the persisted
  // `classification_cohort_outputs` when the complete set + hash match (ZERO
  // FURTHER calls after commit), otherwise coordinates (only when the set is
  // empty) under a scoped lease keeper (audited `cohort_title_consolidation`
  // call bound to the ordinal-0 member child run) and persists every group
  // member's title all-or-nothing and WRITE-ONCE. Prepared members then
  // consume these outputs at the `preComputedTitle` seam (PR6 C5); the
  // coordinator + `cohortCache` are never consulted in active cohort mode. A
  // lost claim (`HeartbeatLostError`) propagates with NO output rows — the
  // reclaiming worker re-enters processCohort and reuses-or-coordinates.
  //
  // HONEST DELIVERY CONTRACT (PR6 hardening B, P1-1): the guarantee is NOT
  // "one LLM call per cohort revision forever". At most one ACTIVE
  // coordination call runs at a time (lease-scoped); once the durable output
  // set commits there are ZERO FURTHER calls (replay-safe after commit —
  // retries/reclaims/member re-executions consume the committed set); a
  // crash between transport success and the outputs transaction leaves the
  // audited call durable with NO committed rows, so a reclaim re-invokes
  // coordination (each invocation audited — there is NO retry cap and no
  // provider idempotency; ONLY a successful commit ends further calls).
  // Transport-level exactly-once would need provider idempotency keys — out
  // of scope.
  //
  // PR6 hardening A: a committed output set that no longer matches the frozen
  // title authority (or a commit-race) is `CohortTitleAuthorityDriftError` —
  // the set is WRITE-ONCE and can never be replaced. PR6 hardening E: the
  // drift SUPERSEDES the parent (authority drift supersedes a run rather than
  // redefining its historical decision) and atomically terminalizes every
  // freeze-created running child, so `claimReadyCurationCohorts` can
  // immediately create a NEW revision; children never executed, no further
  // coordination, no member writes.
  let coordinatedTitles: Map<string, CohortTitleOutput>;
  try {
    coordinatedTitles = await ensureCohortTitles({
      run,
      workspaceId,
      projection,
      cohort,
      frozenLineContext,
      // The title op ignores the page-kind checkpoint arm; the page op
      // (Slice 4) will consume its own arm through the same plumbing.
      ...(hooks?.afterCoordinatedCall
        ? { afterCoordinatedCall: async () => hooks.afterCoordinatedCall!('title', run.id) }
        : {}),
      ...(hooks?.beforeTitleCopyInsert ? { beforeTitleCopyInsert: hooks.beforeTitleCopyInsert } : {}),
    });
  } catch (err) {
    if (err instanceof CohortTitleAuthorityDriftError) {
      const reason = `processCohort aborted: ${err.message}`;
      // Owner-guarded supersede: a run another worker reclaimed is never
      // superseded (nor its children terminalized) by this stale caller. The
      // superseded parent is no longer the current run, so the next claim
      // creates a NEW revision with a fresh title-output set.
      supersedeOwnedCohortRunForOutputDrift(run.id, workerId, reason);
      throw new Error(reason, { cause: err });
    }
    // PR8 review R1 (BLOCKER 1) + review round 2 (P1): a persisted row that
    // fails to parse is corruption of the WRITE-ONCE PARENT-OWNED shared
    // semantic artifact — the member pipeline may produce
    // `completed_with_member_failures`, but corruption of a shared decision
    // the members depend on may NOT. Route it through the SAME owner-guarded
    // supersession lifecycle as authority drift: the old parent is superseded
    // (its corrupt output rows stay immutable under the old run), every
    // running child terminalizes atomically, and the claim slot reopens so a
    // NEW parent revision can commit a fresh complete set. A member failure
    // would strand the revision forever (write-once rows + terminal-current
    // parent + no new claim).
    if (err instanceof CohortTitleOutputCorruptError) {
      const reason = `processCohort aborted: ${err.message}`;
      supersedeOwnedCohortRunForOutputDrift(run.id, workerId, reason);
      throw new Error(reason, { cause: err });
    } else {
      throw err;
    }
  }

  // PR7 (issue #30): the durable parent PAGE op (architecture-report §4.1 —
  // runs AFTER the title op, BEFORE the member loop). Computes the canonical
  // page input hash (P-hash) from frozen page authority only; reuses the
  // persisted `classification_cohort_outputs` (kind `coordinated_page`) when
  // the complete P-set + hash match (ZERO FURTHER calls after commit);
  // otherwise coordinates ONCE (only when the set is empty) under a scoped
  // lease keeper — multi-item groups AND parent singletons via ONE-MEMBER
  // invocations of the UNCACHED page core (`coordinateCohortPagesCore` with
  // `allowSingleProduct`, PR7 review R2 F2; the legacy
  // `llmAssignCategoryPages` singleton path is gone from the parent op,
  // DECISION-A: pages cover ALL members) — and persists EVERY member's result
  // (assigned or abstained) all-or-nothing and WRITE-ONCE. Prepared members
  // then materialize these outputs at the `coordinatedPages` seam (PR7 C5);
  // the transient coordinator + its in-memory cache are never consulted in
  // active cohort mode. Config-level absence (page target disabled / no
  // verified pages, DECISION-C) is expected-empty: no rows, children abstain
  // deterministically. Drift (a committed set that no longer matches the
  // frozen page authority, or a commit-race) throws
  // `CohortPageAuthorityDriftError` — the set is WRITE-ONCE and can never be
  // replaced — and SUPERSEDES the parent via the SAME primitive as titles
  // (`supersedeOwnedCohortRunForOutputDrift`): parent `running→superseded` +
  // every running child terminalized atomically, so the next claim creates a
  // NEW revision. `HeartbeatLostError` propagates with NO output rows — the
  // reclaiming worker re-enters and reuses-or-coordinates.
  let coordinatedPages: Map<string, CoordinatedPageMemberValue>;
  try {
    coordinatedPages = await ensureCohortPages({
      run,
      workspaceId,
      projection,
      frozenLineContext,
      // The page op consumes the page-kind checkpoint arm; the title op
      // (above) consumes the title arm through the same plumbing. This
      // closure is deliberately SYNC (not async): the uncached page core
      // invokes the seam without awaiting it, so only a synchronous throw
      // lands the pre-commit crash inside the transport-success/commit
      // window — an async wrapper would merely float a rejected promise.
      ...(hooks?.afterCoordinatedCall
        ? { afterCoordinatedCall: () => hooks.afterCoordinatedCall!('page', run.id) }
        : {}),
    });
  } catch (err) {
    if (err instanceof CohortPageAuthorityDriftError) {
      const reason = `processCohort aborted: ${err.message}`;
      supersedeOwnedCohortRunForOutputDrift(run.id, workerId, reason);
      throw new Error(reason, { cause: err });
    }
    // PR8 review R1 (BLOCKER 1) + review round 2 (P1): mirror the title op —
    // a corrupt persisted `coordinated_page` row SUPERSEDES the parent via
    // the same primitive (a member failure would strand the revision).
    if (err instanceof CohortPageOutputCorruptError) {
      const reason = `processCohort aborted: ${err.message}`;
      supersedeOwnedCohortRunForOutputDrift(run.id, workerId, reason);
      throw new Error(reason, { cause: err });
    } else {
      throw err;
    }
  }

  // Slice 5: the prepared-member phase lives in
  // `./cohort-curation/members` (resume proof, frozen input construction,
  // pipeline, semantic validation, atomic commit, Brand coherence, parent
  // completion). The orchestrator above keeps run validation, projection
  // parsing, frozen line context, and both parent decision ops; member hooks
  // fan out by phase below.
  return executePreparedMembers({
    run,
    workerId,
    workspacePath,
    workspaceId,
    projection,
    cohort,
    frozenLineContext,
    coordinatedTitles,
    coordinatedPages,
    hooks: hooks
      ? {
          onPipelineInFlight: hooks.onPipelineInFlight,
          afterMemberPipeline: hooks.afterMemberPipeline,
          afterMemberProjectionDependencyInsert: hooks.afterMemberProjectionDependencyInsert,
          afterMemberCommit: hooks.afterMemberCommit,
          beforeSemanticValidation: hooks.beforeSemanticValidation,
        }
      : undefined,
  });
}
