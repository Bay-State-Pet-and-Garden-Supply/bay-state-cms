/**
 * Parent cohort title decisions (plan Slice 3) — the durable parent title op
 * as the first user of the closed durable-set lifecycle (`decisions.ts`).
 *
 * Title-specific policy lives here: the multi-item target set, the frozen
 * title authority + T-hash preparation, the latest-superseded-run copy
 * policy, the audited title engine invocation, and member title-input
 * selection. Kind-agnostic mechanics (set inspection, parse-failure
 * collection, write-once insert with commit-race conversion, lease-scoped
 * ownership) live in `decisions.ts`.
 *
 * Semantics moved verbatim from `../cohort-title-coordinator.ts` (now a thin
 * transitional adapter, deleted in Slice 6):
 *
 * 1. **Input hash** — T-hash over FROZEN TITLE AUTHORITY ONLY: final
 *    membership hash, per-member frozen title slice, Execution Product Type
 *    resolution, FORMAT_RULES digest, operation-specific H5 title slice, and
 *    the executed `OPERATION_PARAMETERS.cohort_title_consolidation` tuple.
 *    Never live item rows, never the old cache fingerprint, never OCR
 *    provenance hashes.
 * 2. **Reuse** — a COMPLETE `curated_title` set for this run (every member of
 *    every multi-item group — singletons are never coordinated and have no
 *    row) with every row's `input_hash` equal to the fresh T-hash returns the
 *    parsed map with ZERO LLM calls.
 * 3. **Drift fails closed** — a NONEMPTY committed set that is incomplete,
 *    over-complete, or hash-mismatched throws `CohortTitleAuthorityDriftError`
 *    (never re-coordinate, never replace, never delete).
 * 4. **Cross-parent same-T-hash reuse** — TITLES ONLY: the LATEST SUPERSEDED
 *    parent's exactly-matching set is copied in ONE transaction with the
 *    ORIGINAL `model_call_id` values preserved (row-level audit provenance —
 *    no title proposal ever references them).
 * 5. **Coordinate** — only when the set is EMPTY, under a scoped lease
 *    keeper, audited `cohort_title_consolidation` call bound to the ordinal-0
 *    member child run; persist all-or-nothing and WRITE-ONCE.
 *
 * HONEST DELIVERY CONTRACT: at most one ACTIVE coordination call at a time;
 * zero FURTHER calls once the durable set commits; replay-safe after commit;
 * each pre-commit crash MAY cause another independently audited invocation
 * (no retry cap, no provider idempotency). Never consults `cohortCache` /
 * `coordinateCohortItemsOnce` — the DB outputs are the sole
 * already-coordinated authority.
 *
 * Package-internal seam, not a public workflow step. Never imports the
 * transitional `../cohort-curator` (boundary R2).
 */
import {
  getCohortTitleOutputsByRun,
  insertCohortTitleOutputsOnce,
} from '../../db/repositories/classification-cohort-output-repo';
import type { CohortTitleOutputRow } from '../../db/repositories/classification-cohort-output-repo';
import {
  getRuntimeSnapshotByHash,
  requireModelCallContext,
  getModelExecutionPlanEntry,
} from '../../classification/runtime-snapshot';
import {
  getCohortMemberRunForTitleAudit,
  getLatestSupersededRunForCohort,
} from '../../db/repositories/classification-cohort-run-repo';
import { modelPolicyViewFromConfig } from '../model-policy-snapshot';
import { coordinateCohortItems, formatDeterministicTitle, groupByProductLine } from '../cohort-name-coordinator';
import { CohortTitleOutputSchema } from '../../shared/schemas/cohorts';
import type { CohortTitleOutput } from '../../shared/schemas/cohorts';
import type { FrozenProductLineContext } from './frozen-evidence';
import type { OnboardingItem } from '../../shared/schemas/onboarding';
import type {
  CohortRun,
  CurationCohort,
  ExecutionEvidenceProjection,
  ExecutionEvidenceProjectionMemberV1,
  ExecutionEvidenceProjectionMemberV2,
} from '../../shared/schemas/cohorts';
import {
  inspectDurableSet,
  collectRowParseFailures,
  insertDecisionSetOnce,
  withOwnedDecisionScope,
} from './decisions';

// ─── Error identity (moved verbatim; re-exported by the transitional adapter) ─

/** Parse one persisted output row's payload through the shared title schema
 *  (fail-closed on corrupt stored JSON — a corrupt row never yields a title). */
function parseTitleRow(row: CohortTitleOutputRow): CohortTitleOutput {
  return CohortTitleOutputSchema.parse(JSON.parse(row.outputValueJson));
}

/**
 * Deterministic per-SKU parse-failure signal (PR8 review R1, BLOCKER 1):
 * thrown by the REUSE path when one or more persisted `curated_title` rows
 * for a run fail to parse through `CohortTitleOutputSchema` (corrupt stored
 * JSON, or a schema violation such as an empty title). Carries the parent
 * run id, the affected product SKUs with their original causes, and the
 * USABLE parsed outputs for the unaffected rows so `processCohort` can
 * supersede with a diagnostic. Supersession diagnostic (PR8 review R1 +
 * review round 2 P1): a persisted `curated_title` row that fails to parse is
 * corruption of the WRITE-ONCE PARENT-OWNED shared semantic artifact — the
 * parent is SUPERSEDED via `supersedeOwnedCohortRunForOutputDrift` (never a
 * member failure: a member failure would strand the revision — write-once
 * rows stay immutable under a terminal-current parent, and no new revision
 * could be claimed). The class retains per-SKU failures + the usable parsed
 * map as DIAGNOSTICS only.
 */
export class CohortTitleOutputCorruptError extends Error {
  readonly runId: string;
  readonly failures: Array<{ sku: string; cause: string }>;
  readonly usableOutputs: Map<string, CohortTitleOutput>;

  constructor(
    runId: string,
    failures: Array<{ sku: string; cause: string }>,
    usableOutputs: Map<string, CohortTitleOutput>,
  ) {
    super(
      `[CohortTitleOutputCorrupt] Persisted curated_title outputs for run ${runId} failed to parse: ` +
        failures.map(f => `${f.sku} (${f.cause})`).join('; ') +
        ' — the shared title set is no longer coherent; the parent run must be superseded so a NEW revision can commit a fresh set.',
    );
    this.name = 'CohortTitleOutputCorruptError';
    this.runId = runId;
    this.failures = failures;
    this.usableOutputs = usableOutputs;
  }
}

/**
 * Deterministic authority-drift signal (PR6 hardening A). Thrown when a
 * NONEMPTY committed `curated_title` set for a run does not match the freshly
 * computed canonical title input hash (or is incomplete). The set is
 * WRITE-ONCE — it can never be replaced, so the op FAILS CLOSED instead of
 * re-coordinating. Carries the run id, the expected (current) hash, the
 * stored hash(es), and the persisted row count. Also thrown when an
 * `insertCohortTitleOutputsOnce` commit-race reports an already-committed set.
 */
export class CohortTitleAuthorityDriftError extends Error {
  readonly runId: string;
  readonly expectedHash: string;
  readonly storedHashes: string[];
  readonly rowCount: number;

  constructor(runId: string, expectedHash: string, storedHashes: string[], rowCount: number) {
    super(
      `[CohortTitleAuthorityDrift] Durable title outputs for run ${runId} are write-once but no longer match the ` +
        `frozen title authority: expected input_hash ${expectedHash}, stored hash(es) [${storedHashes.join(', ')}], ` +
        `${rowCount} row(s). A committed output set can never be replaced — this is corruption or an illegal ` +
        'mutation; failing the run closed without re-coordination.',
    );
    this.name = 'CohortTitleAuthorityDriftError';
    this.runId = runId;
    this.expectedHash = expectedHash;
    this.storedHashes = storedHashes;
    this.rowCount = rowCount;
  }
}

// ─── Title policy: target set ─────────────────────────────────────────────────

/**
 * The exact multi-item-group member set (DECISION-O: singletons are never
 * coordinated and never get an output row). Computed with the SAME grouping
 * the coordinator uses (single source of truth).
 *
 * e09 T1 INVARIANT (round-3 FIX 3): production groups via
 * groupByProductLine(frozenItems) → familyGroupingIdentityFor →
 * extractNameStem, which is BYTE-EQUIVALENT to durable product-family-v1
 * membership ONLY while GROUPING_VERSION and the frozen raw inputs are
 * unchanged. The `authoritativeCohortId` seam in coordinateCohortItems
 * exists for future direct-cohort callers; any divergence between re-derived
 * stems and frozen cohort membership (e.g. manual membership corrections)
 * MUST route through that seam instead of relying on this equivalence.
 */
export function computeTitleTargetSet(frozenItems: FrozenProductLineContext['frozenBatchItems']): Set<string> {
  const multiMemberSkus = new Set<string>();
  for (const groupItems of groupByProductLine(frozenItems).values()) {
    if (groupItems.length <= 1) continue;
    for (const item of groupItems) {
      if (item.upc) multiMemberSkus.add(item.upc);
    }
  }
  return multiMemberSkus;
}

// ─── Title policy: frozen authority ───────────────────────────────────────────

export interface TitleFrozenAuthority {
  inputHash: string;
  /** The frozen `cohort_title_consolidation` plan entry (or undefined → registry consts). */
  titlePlanEntry: ReturnType<typeof getModelExecutionPlanEntry> | undefined;
  /** Snapshot-bound policy view, retained ONLY for transport enforcement. */
  boundPolicyView: ReturnType<typeof modelPolicyViewFromConfig>;
  executionTypeAuthority: ReturnType<typeof titleExecutionTypeAuthorityFromRun>;
  memberSnapshot0: NonNullable<ReturnType<typeof getRuntimeSnapshotByHash>>;
  childRun0Id: string;
}

/**
 * Prepare the frozen title authority: ordinal-0 child audit binding, frozen
 * member snapshot, operation-specific plan entry, canonical Execution Product
 * Type authority, and the T-hash. PURE READ ONLY: the parent op never creates
 * a child and never updates refs before the lease is asserted. A missing
 * frozen snapshot / plan entry / model-call context FAILS CLOSED before any
 * transport — a non-audited live title call is never made.
 */
export function prepareTitleAuthority(params: {
  run: CohortRun;
  workspaceId: string;
  projection: ExecutionEvidenceProjection;
  titleOperationParameters?: { temperature: number; maxTokens: number | null };
}): TitleFrozenAuthority {
  const { run, workspaceId, projection } = params;
  const orderedMembers = [...projection.members].sort((a, b) => a.ordinal - b.ordinal);
  const member0 = orderedMembers[0];
  const childRun0 = getCohortMemberRunForTitleAudit(run.id, member0.onboardingItemId);
  if (!childRun0 || !childRun0.configSnapshotId || !childRun0.configSnapshotHash) {
    throw new Error(
      `[CohortTitles] Ordinal-0 member ${member0.onboardingItemId} (run ${run.id}) has no child run ` +
        'with freeze-persisted snapshot refs — refusing to coordinate titles without the frozen audit authority.',
    );
  }
  const memberSnapshot0 = getRuntimeSnapshotByHash(workspaceId, childRun0.configSnapshotHash);
  if (!memberSnapshot0) {
    throw new Error(
      `[CohortTitles] Frozen member runtime snapshot ${childRun0.configSnapshotHash} not found for ` +
        `ordinal-0 member ${member0.onboardingItemId} (run ${run.id}) — refusing to coordinate titles without ` +
        'the frozen audit authority.',
    );
  }
  const boundPolicyView = modelPolicyViewFromConfig(
    memberSnapshot0.modelPolicy as never,
    memberSnapshot0.snapshotHash,
  );
  const titlePlanEntry = getModelExecutionPlanEntry(memberSnapshot0, 'cohort_title_consolidation');
  // ONE canonical Execution Product Type title authority {id, label,
  // confidence, outcome} — the SAME object feeds the T-hash (label
  // participates) and the prompted context (id + label render). A label
  // change therefore changes BOTH the hash and the prompt; a null run type
  // (abstained/conflicted) yields all-null fields for both.
  const executionTypeAuthority = titleExecutionTypeAuthorityFromRun(run, memberSnapshot0);
  const inputHash = computeCohortTitleInputHash({
    run,
    projection,
    titlePlanEntry: titlePlanEntry ?? undefined,
    executionTypeAuthority,
    // Test-only: production passes nothing → the registry tuple (the executed
    // authority) participates via the hash's default.
    ...(params.titleOperationParameters
      ? { titleOperationParameters: params.titleOperationParameters }
      : {}),
  });
  return {
    inputHash,
    titlePlanEntry: titlePlanEntry ?? undefined,
    boundPolicyView,
    executionTypeAuthority,
    memberSnapshot0,
    childRun0Id: childRun0.id,
  };
}

// ─── Parent op ────────────────────────────────────────────────────────────────

export interface EnsureCohortTitlesParams {
  /** The frozen `running` cohort run (final membership + execution type + claim). */
  run: CohortRun;
  workspaceId: string;
  /** The frozen execution-evidence projection (v1 or v2 — source-aware). */
  projection: ExecutionEvidenceProjection;
  /** Owning cohort (read for the cross-parent copy lookup only). */
  cohort: CurationCohort;
  /** Frozen product-line sibling context (PR3 hardening Commit B / R2). */
  frozenLineContext: FrozenProductLineContext;
  /**
   * Test-only crash seam (PR6 hardening B, issue #30 P1-1): fires AFTER the
   * coordinated title call resolves (its audited `classification_model_calls`
   * rows are durable) and AFTER the post-await ownership guard, but BEFORE
   * the outputs transaction commits — deterministically simulating a worker
   * crash exactly between transport success and the durable output-set
   * commit. Production callers never pass it.
   */
  afterCoordinatedCall?: () => void | Promise<void>;
  /**
   * Test-only race seam (PR13 C2 review R1): fires INSIDE the cross-parent
   * copy path, after the lease-ownership assertion but BEFORE the copy
   * `insertCohortTitleOutputsOnce` — deterministically simulating the
   * sibling-commit race. Production callers never pass it.
   */
  beforeTitleCopyInsert?: () => void | Promise<void>;
  /**
   * Test-only title-parameter override (PR13 review R2): models a DEPLOYMENT
   * whose `OPERATION_PARAMETERS.cohort_title_consolidation` tuple differs —
   * the T-hash then differs and cross-parent reuse fails closed to fresh
   * coordination. Production callers never pass it: the registry tuple is
   * the executed authority.
   */
  titleOperationParameters?: { temperature: number; maxTokens: number | null };
}

/**
 * The durable parent title coordination op, on the shared lifecycle. See the
 * module JSDoc for the reuse rule, the lease-wrapped coordinate step, the
 * all-or-nothing persistence, the `HeartbeatLostError` propagation contract,
 * and the HONEST DELIVERY CONTRACT: at most one ACTIVE coordination call at
 * a time, zero FURTHER calls once the durable output set commits, replay-safe
 * after commit, and a crash between transport success and output commit may
 * re-invoke coordination (each invocation audited).
 */
export async function ensureCohortTitles(
  params: EnsureCohortTitlesParams,
): Promise<Map<string, CohortTitleOutput>> {
  const { run, workspaceId, projection, frozenLineContext } = params;
  // The frozen sibling views + the run row are the entire authority.

  const frozenItems = frozenLineContext.frozenBatchItems;
  const multiMemberSkus = computeTitleTargetSet(frozenItems);
  const authority = prepareTitleAuthority({
    run,
    workspaceId,
    projection,
    ...(params.titleOperationParameters
      ? { titleOperationParameters: params.titleOperationParameters }
      : {}),
  });
  const { inputHash } = authority;

  // Persisted rows are read BEFORE any early return so the no-multi-member
  // case also fails closed on unexpected rows (PR6 hardening C SHOULD-FIX 1).
  // Pure read: no keeper, no LLM, no writes.
  const existingRows = getCohortTitleOutputsByRun(run.id);

  // DECISION-O + SHOULD-FIX 1: no multi-item groups ⇒ NO output rows are
  // expected. Any persisted rows for this run are write-once corruption.
  if (multiMemberSkus.size === 0) {
    // NB: `complete-match` is unreachable here (it requires rows, which
    // would be write-once corruption) — only `drift` throws, `empty`
    // returns the member-local outcome.
    const inspection = inspectDurableSet({ expectedSkus: multiMemberSkus, rows: existingRows, inputHash });
    if (inspection.status === 'drift') {
      throw new CohortTitleAuthorityDriftError(run.id, inputHash, inspection.storedHashes, inspection.rowCount);
    }
    return new Map();
  }

  // REUSE when the persisted set is EXACTLY the expected set AND every row's
  // hash matches. Pure reads.
  const rowBySku = new Map(existingRows.map(row => [row.productSku, row]));
  const inspection = inspectDurableSet({ expectedSkus: multiMemberSkus, rows: existingRows, inputHash });
  if (inspection.status === 'complete-match') {
    const { parsed: map, failures } = collectRowParseFailures(multiMemberSkus, sku =>
      parseTitleRow(rowBySku.get(sku)!),
    );
    if (failures.length > 0) {
      console.error(
        `[CohortTitles] ${failures.length} persisted curated_title row(s) for run ${run.id} failed to parse: ` +
          failures.map(f => `${f.sku} (${f.cause})`).join('; '),
      );
      throw new CohortTitleOutputCorruptError(run.id, failures, map);
    }
    console.log(
      `[CohortTitles] Reusing ${map.size} durable title outputs for run ${run.id} (complete set + hash match, zero LLM calls).`,
    );
    return map;
  }

  // WRITE-ONCE: any NONEMPTY committed set that is incomplete, over-complete,
  // or hash-mismatched is authority drift — FAIL CLOSED, never re-coordinate,
  // never delete. An incomplete/over-complete nonempty set can only be
  // corruption: the insert is all-or-nothing, so a partial or extra-row set
  // is never produced by any writer.
  if (inspection.status === 'drift') {
    throw new CohortTitleAuthorityDriftError(run.id, inputHash, inspection.storedHashes, inspection.rowCount);
  }

  // Cross-parent same-T-hash reuse (PR13 C2, DECISION-A/B) — TITLES ONLY. The
  // CURRENT run's set is EMPTY here. A SUPERSEDED parent revision's committed
  // title set is the SAME frozen-authority decision when it is EXACTLY the
  // expected multi-item-member set AND every row's input_hash equals the fresh
  // T-hash — COPY its rows into the current run in ONE transaction
  // (write-once preserved, `model_call_id` PRESERVED — DECISION-B) and return
  // the parsed map with ZERO LLM calls. See the module JSDoc for the full
  // safety contract (superseded-only, exact-set, old rows untouched).
  const reusableRun = getLatestSupersededRunForCohort(params.cohort.id);
  if (reusableRun) {
    const reusableRows = getCohortTitleOutputsByRun(reusableRun.id);
    const reusableBySku = new Map(reusableRows.map(row => [row.productSku, row]));
    const reusableInspection = inspectDurableSet({
      expectedSkus: multiMemberSkus,
      rows: reusableRows,
      inputHash,
    });
    if (reusableInspection.status === 'complete-match') {
      // Parse every source row through the shared schema; a row that fails to
      // parse makes the source set unusable → skip the copy and fall through
      // to fresh coordination (deterministic — never a supersede loop on a
      // corrupt OLD row; the current run's set is still empty).
      const copyRows: Array<{
        productSku: string;
        title: string;
        source: CohortTitleOutput['source'];
        modelCallId: string | null;
      }> = [];
      let sourceCorrupt = false;
      for (const sku of multiMemberSkus) {
        const row = reusableBySku.get(sku)!;
        try {
          const parsed = parseTitleRow(row);
          copyRows.push({
            productSku: sku,
            title: parsed.title,
            source: parsed.source,
            // DECISION-B: the ORIGINAL producing call id is preserved as
            // ROW-LEVEL AUDIT PROVENANCE. No title proposal ever references
            // it — title proposals carry the MEMBER's own name-consolidation
            // call ids (the C6b linkage exemption is category_page +
            // coordinated_page ONLY and must never be extended to titles;
            // the preserved id keeps the copied row's provenance truthful).
            modelCallId: row.modelCallId,
          });
        } catch {
          sourceCorrupt = true;
          break;
        }
      }
      if (!sourceCorrupt) {
        // The copy WRITES — a stale pre-reclaim worker must never commit rows
        // into a run it no longer owns. The lease keeper asserts ownership
        // exactly like the coordinate path does before its insert; a lost
        // claim aborts here with NO copied rows.
        const copyWorkerId = run.claimedBy;
        if (!copyWorkerId) {
          throw new Error(`ensureCohortTitles: run ${run.id} has no claim owner (cross-parent reuse).`);
        }
        await withOwnedDecisionScope({
          runId: run.id,
          workerId: copyWorkerId,
          body: async keeper => {
            keeper.assertHeld();
            // Test-only race seam (PR13 C2 review R1): fires after the
            // ownership assertion but before the copy insert — the racing
            // sibling's rows become visible HERE, converting the insert's
            // write-once throw into the deterministic drift error below.
            await params.beforeTitleCopyInsert?.();
            insertDecisionSetOnce({
              insert: () =>
                insertCohortTitleOutputsOnce({
                  workspaceId,
                  runId: run.id,
                  inputHash,
                  outputs: copyRows,
                }),
              readCommittedHashes: () => getCohortTitleOutputsByRun(run.id),
              toDriftError: (storedHashes, rowCount) =>
                new CohortTitleAuthorityDriftError(run.id, inputHash, storedHashes, rowCount),
            });
          },
        });
        const map = new Map<string, CohortTitleOutput>();
        for (const copy of copyRows) {
          map.set(copy.productSku, { title: copy.title, source: copy.source });
        }
        console.log(
          `[CohortTitles] Reused ${map.size} durable title outputs from superseded run ${reusableRun.id} (same T-hash, zero LLM calls).`,
        );
        return map;
      }
    }
  }

  // Coordinate ONCE under a scoped lease keeper + persist all-or-nothing. The
  // keeper renews the parent lease on a TTL/3 cadence while the audited call
  // is in flight; `assertHeld` (forwarded into the transport AND re-asserted
  // after the await) aborts with `HeartbeatLostError` the moment the claim is
  // lost — no output rows are ever written by a stale owner. The coordinate
  // path is reached ONLY when the set is EMPTY (zero rows — see the drift
  // guard above).
  const workerId = run.claimedBy;
  if (!workerId) {
    throw new Error(`ensureCohortTitles: run ${run.id} has no claim owner.`);
  }
  return withOwnedDecisionScope({
    runId: run.id,
    workerId,
    body: async keeper => {
      // REQUIRE the frozen plan + model-call context before any transport —
      // a schema-v1 snapshot (no frozen plan), a missing
      // `cohort_title_consolidation` plan entry, or plan/registry version
      // drift fails the op closed here (never a non-audited live call). A
      // configured route that is policy-denied/unavailable still flows
      // through the AUDITED terminal path (`policy_denied`/`unavailable`
      // classification_model_calls rows) and then deterministically falls
      // back to persisted `cohort_fallback` outputs — the audit binding is
      // never dropped.
      const modelCallContext = requireModelCallContext(
        authority.memberSnapshot0,
        authority.childRun0Id,
        'cohort_title_consolidation',
        1,
      );
      if (!modelCallContext) {
        throw new Error(
          `[CohortTitles] No audited model-call context for run ${run.id} ` +
            '— refusing to make a non-audited title call.',
        );
      }
      // The ACTIVE parent op is the ONLY caller that opts into the
      // T-hash-only prompt signals (webBrand/ocrWeight/ocrFlavor + Execution
      // Product Type context) — legacy/shadow calls never pass this and stay
      // byte-identical. The SAME `ExecutionTypeTitleAuthority` object feeds
      // the T-hash and the prompt.
      const executionTypeContext = authority.executionTypeAuthority.id
        ? authority.executionTypeAuthority
        : null;
      // Per-group model-call provenance — each group's producing call id is
      // captured for ITS member SKUs, so every persisted `llm_cohort` row
      // carries the call that actually produced it.
      const coordinatedCallIdBySku = new Map<string, string>();
      const coordinated = await coordinateCohortItems(
        frozenItems,
        authority.boundPolicyView,
        {
          // DECISION-N: the audited title call binds to the ordinal-0 member
          // child run + its persisted runtime snapshot; the returned callId
          // becomes the durable output-row `model_call_id`. The call is
          // ALWAYS audited — the snapshot, plan entry, and model-call context
          // are all required above.
          modelCall: modelCallContext,
          snapshot: authority.memberSnapshot0,
          assertHeld: () => keeper.assertHeld(),
          includeTitleHashSignals: true,
          executionTypeContext,
          onCoordinatedCallId: (callId: string, skus: string[]) => {
            for (const sku of skus) {
              coordinatedCallIdBySku.set(sku, callId);
            }
          },
        },
      );
      // Post-await ownership guard BEFORE ANY write.
      keeper.assertHeld();

      const outputs = [...coordinated.entries()].map(([productSku, ct]) => ({
        productSku,
        title: ct.title,
        source: ct.source,
        // Durable provenance: only LLM-coordinated titles carry the call id of
        // the group that produced them; deterministic fallback rows keep NULL.
        modelCallId:
          ct.source === 'llm_cohort' ? (coordinatedCallIdBySku.get(productSku) ?? null) : null,
      }));

      // Test-only crash seam (PR6 hardening B, P1-1): a crash EXACTLY here —
      // after the audited call resolved (its audit rows durable) and after the
      // ownership guard, but BEFORE the outputs transaction — leaves ZERO
      // committed rows. A reclaim re-enters; the set is still empty, so it
      // coordinates again (each invocation independently audited). Production
      // callers never pass `afterCoordinatedCall`, so this is a no-op in
      // production.
      await params.afterCoordinatedCall?.();

      // ONE transaction — all members persist or NONE. WRITE-ONCE: the insert
      // is guarded by `insertCohortTitleOutputsOnce`'s three-way semantics —
      // zero rows ⇒ insert; any rows ⇒ `CohortOutputAlreadyCommittedError`
      // (never delete). A commit race (a sibling committed between our
      // pure-read reuse check and this insert) is converted to
      // `CohortTitleAuthorityDriftError` so the set can never be silently
      // split.
      insertDecisionSetOnce({
        insert: () =>
          insertCohortTitleOutputsOnce({
            workspaceId,
            runId: run.id,
            inputHash,
            outputs,
          }),
        readCommittedHashes: () => getCohortTitleOutputsByRun(run.id),
        toDriftError: (storedHashes, rowCount) =>
          new CohortTitleAuthorityDriftError(run.id, inputHash, storedHashes, rowCount),
      });

      const map = new Map<string, CohortTitleOutput>();
      for (const output of outputs) {
        map.set(output.productSku, { title: output.title, source: output.source });
      }
      console.log(
        `[CohortTitles] Persisted ${map.size} title outputs for run ${run.id} ` +
          `(${[...map.values()].filter(v => v.source === 'llm_cohort').length} llm_cohort, ` +
          `${[...map.values()].filter(v => v.source === 'cohort_fallback').length} cohort_fallback).`,
      );
      return map;
    },
  });
}

// ─── Member input selection ───────────────────────────────────────────────────

/**
 * Select one member's title input from the settled parent decision set.
 * DECISION-O enforced at consumption: true singletons stay member-local
 * (null) even if a stray row ever existed — the op's expected-empty guard is
 * the first gate (no singleton rows are ever committed); this is the second
 * gate, never the first. Grouped members without a row get null (a missing
 * row for a grouped member cannot happen after a settled op — the set is
 * exact — so null here means "no coordinated title", never "look elsewhere").
 */
export function titleInputForMember(
  settledTitles: Map<string, CohortTitleOutput> | undefined,
  memberGroupSizes: Map<string, number> | undefined,
  memberSku: string,
): CohortTitleOutput | null {
  if ((memberGroupSizes?.get(memberSku) ?? 1) < 2) return null;
  return settledTitles?.get(memberSku) ?? null;
}

// ─── Prepared-member title selection (Slice 5) ──────────────────────────────
/**
 * Select one member's settled title input for prepared execution (moved
 * verbatim out of the shared curation body in Slice 5 so cohort input
 * construction happens before the pipeline seam; used by the member
 * executor AND the transitional prepared-context adapter).
 *
 * PR8 C2 (DECISION-B): a MISSING stored title output for a multi-item
 * group member is a parent-op contract violation — the member FAILS with a
 * deterministic error (no invented title). The DECISION-R warn+fallback is
 * parent-op-only in active cohort mode: a durable row with source
 * 'cohort_fallback' is legitimate (the parent op wrote it), but a MISSING
 * row can never be repaired by the child. The fail-closed throw is keyed on
 * the FROZEN per-member group sizes (present AND this member's group >= 2).
 * Hand-built contexts that omit `memberGroupSizes` keep the legacy
 * warn+fallback. PR8 review R1 (BLOCKER 2d): an EMPTY title from the
 * durable map fails closed instead of threading into name_consolidation.
 * PR8 review R1 (identity): errors carry BOTH member and run identity.
 */
export function selectPreparedMemberTitleInput(args: {
  coordinatedTitles: Map<string, CohortTitleOutput> | undefined;
  memberGroupSizes: Map<string, number> | undefined;
  siblingSkusLength: number;
  item: OnboardingItem;
  runId: string;
}): CohortTitleOutput | null {
  const { coordinatedTitles, memberGroupSizes, siblingSkusLength, item, runId } = args;
  const selected = coordinatedTitles?.get(item.upc);
  if (selected) {
    if (typeof selected.title !== 'string' || selected.title.trim().length === 0) {
      throw new Error(
        `Member ${item.upc ?? item.id} (run ${runId}) has an EMPTY persisted cohort title output in active cohort mode ` +
          '(PR8 review R1): failing closed — no title may be invented from a corrupt parent output.',
      );
    }
    return selected;
  }
  const memberGroupSize = memberGroupSizes?.get(item.upc) ?? siblingSkusLength;
  if (memberGroupSizes !== undefined && memberGroupSize >= 2) {
    throw new Error(
      `Member ${item.upc ?? item.id} (run ${runId}) is missing a persisted cohort title output in active cohort mode ` +
        '(PR8 DECISION-B): the parent-op contract was violated and no title may be invented; the member fails closed.',
    );
  }
  console.warn(
    `[ProductCurator] Member ${item.upc} missing a persisted cohort title output — using deterministic fallback.`,
  );
  return {
    title: formatDeterministicTitle(item.name ?? item.upc, item.brandHint),
    source: 'cohort_fallback' as const,
  };
}

// ─── T-hash authority (moved verbatim from `../cohort-title-hash.ts`, Slice 6) ───

/**
 * Canonical cohort title input hash (issue #30, PR6 C2) — the "T-hash".
 *
 * PURE module: `computeCohortTitleInputHash` derives a canonical SHA-256 from
 * FROZEN TITLE AUTHORITY ONLY (architecture-report §3, DECISION-P/Q). It is
 * the per-row `input_hash` of the durable `classification_cohort_outputs`
 * table and the reuse key of the parent `ensureCohortTitlesCoordinated` op:
 * outputs for a run are reusable iff every multi-item group member has a row
 * AND every row's input hash matches the freshly computed T-hash. The hash is
 * recomputed on every `processCohort` entry (cheap, pure); a mismatch means
 * the frozen title authority changed (impossible in the normal flow — the
 * projection + run authorities are immutable once frozen — but possible if
 * prompt/format/rule constants changed between deployments). A mismatch
 * against a committed output set is WRITE-ONCE drift: the parent op FAILS
 * CLOSED with `CohortTitleAuthorityDriftError` — the set is never
 * re-coordinated or replaced, and the run terminates deterministically with
 * no further coordination and no further writes. REPLAY CONTRACT: at most
 * one ACTIVE coordination call at a time; a crash between transport success
 * and the output-set commit may cause ANOTHER independently audited
 * invocation (no retry cap — each pre-commit crash repeats this); only a
 * successful commit makes later entries call-free (replay-safe after
 * commit).
 *
 * HASH ONLY FROZEN TITLE AUTHORITY — explicit exclusions (DECISION-P):
 * - NO live `onboarding_items` rows, stage/status, `curation_data_json`, or
 *   `updated_at` — the members array is built strictly from
 *   `projection.members` (the persisted `execution-evidence-v1` payload).
 * - NO cache-key shape (`buildCacheKey`, cohort-name-coordinator): the old
 *   string fingerprint + `modelIdentity {provider, model, policyDigest}`
 *   combined with FORMAT_RULES is replaced by this structured canonical JSON.
 * - NO non-title projection fields: `description`, `bulletPoints`,
 *   `searchKeywords`, `customFields`, `fieldProvenance`,
 *   `primaryImage`/`additionalImages`.
 * - NO OCR-evidence `evidenceHash` / `ocrInputHash` / `ocrExecutionDigest`
 *   (OCR *provenance*, not title text — an OCR re-run must never retitle).
 * - Milestone E EXCEPTION: the narrow source-kind/provenance BINDING slice
 *   (`sourceProvenance` — item/extraction source type, URL null-ness,
 *   extraction method, sourcing generation id, sorted accepted attempt /
 *   provider ids, distributor evidence hash) DOES participate. Distributor-
 *   record evidence is a different input identity than official-page
 *   evidence, and generation/attempt/hash drift must never reuse title
 *   outputs (plan acceptance: source/generation/attempt/hash drift blocks
 *   reuse). For official-page members the slice is the constant
 *   official_page identity (no behavioral change to official re-runs).
 * - NO H3 config / H4 Page catalog (titles do not depend on them).
 * - Only the title H5 slice: the frozen `cohort_title_consolidation` plan
 *   entry (provider/model/promptTemplateVersion/ruleVersion) + `FORMAT_RULES`
 *   digest. An unrelated route change (e.g. `attribute_ranking`) changes H5
 *   but NOT the T-hash ⇒ outputs are reused.
 *
 * PR13 (issue #30, DECISION-C): the hashed model-execution authority is
 * genuinely OPERATION-SPECIFIC — exactly `{operation,
 * 'cohort_title_consolidation', promptTemplateVersion, ruleVersion, provider,
 * model}` from the frozen plan entry (registry consts when absent), mirroring
 * the P-hash's operation-specific contract. The broad H5 `policyDigest` is
 * deliberately NOT hashed: it is routing state that changes with ANY model
 * route change, not a title authority — dropping it means an unrelated
 * non-title route change never re-coordinates titles. PRE-RELEASE COMPOSITION
 * CHANGE: sets committed under the OLD composition (policy digest hashed)
 * drift under this hash — documented in ADR 0013 PR13; there is no
 * production data to migrate.
 *
 * The per-member slice is `titleAuthorityFromProjectionMember`: productSku,
 * spreadsheet identity (name/expectedName/brandHint), web title/brand, and
 * the packaging-OCR title signals (`packagingOcrData.productName ??
 * packagingTitle`, `weight`, `flavorVariety` — DECISION-Q: weight/flavor are
 * title-format-relevant signals the FORMAT_RULES mandate). The slice is
 * PROMPT-NORMALIZED (the same truncation the coordinated prompt renders:
 * 200 chars for brand signals, 500 for the rest) so the hashed authority
 * equals the prompted authority by construction — a suffix-only mutation
 * beyond the cutoffs changes neither the prompt NOR the hash.
 */
import { hashCanonicalJson } from '../../shared/stable-id';
import { FORMAT_RULES } from '../title-prompt-template';
import { FAMILY_TITLE_CONSISTENCY_VERSION } from '../../classification/family-title-consistency';
import { TITLE_LINT_VERSION } from '../../classification/title-lint';
import {
  OPERATION_PARAMETERS,
  PROMPT_TEMPLATE_VERSIONS,
  RULE_VERSIONS,
} from '../../classification/model-operation-registry';
import type { ModelExecutionPlanEntry } from '../../classification/model-operation-registry';
import type {
  ExecutionTypeTitleAuthority,
  SourceProvenanceSlice,
} from '../../classification/cohort-decision-authority';
import {
  sourceProvenanceFromMember,
  normalizeTitleAuthorityString,
  TITLE_AUTHORITY_TRUNCATION,
  titleExecutionTypeAuthorityFromRun,
} from '../../classification/cohort-decision-authority';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CohortTitleInputHashParams {
  /** The cohort run (final_membership_hash + execution Product Type). */
  run: CohortRun;
  /** Frozen per-member title authority (the persisted execution-evidence-v1 payload). */
  projection: ExecutionEvidenceProjection;
  /** Frozen `cohort_title_consolidation` plan entry (H5 title slice); absent → registry consts. */
  titlePlanEntry?: ModelExecutionPlanEntry;
  /**
   * PR13 review R2 (issue #30): the title operation's EXECUTION PARAMETER
   * slice — `{temperature, maxTokens}` as applied by the audited transport
   * (llm-client reads `OPERATION_PARAMETERS[op]` when the caller supplies no
   * override, and the title coordinator supplies none). Absent → the
   * registry's `cohort_title_consolidation` tuple (the deployed execution
   * authority). A parameter-only release therefore changes the T-hash, so
   * cross-parent same-T-hash reuse can never copy a set produced under a
   * different parameter contract. Tests pass explicit tuples to prove the
   * participation; production callers never do.
   */
  titleOperationParameters?: { temperature: number; maxTokens: number | null };
  /**
   * Frozen Execution Product Type authority (PR6 hardening C, issue #30
   * P1-3): the SAME `ExecutionTypeTitleAuthority` object the coordinated
   * prompt renders — id + label + confidence + outcome. A label change
   * changes the T-hash (the prompt would change, so re-coordination is
   * correct). Absent → a null authority is hashed (abstained/conflicted).
   */
  executionTypeAuthority?: ExecutionTypeTitleAuthority | null;
}

/**
 * The frozen title-relevant slice of one projection member. Every field here
 * participates in the T-hash; everything else on the member is excluded by
 * design (see the module JSDoc).
 */
export interface CohortTitleAuthorityMember {
  productSku: string | null;
  spreadsheetName: string;
  expectedName: string | null;
  brandHint: string | null;
  webTitle: string | null;
  webBrand: string | null;
  /** `ocr.packagingOcrData?.productName ?? packagingTitle` — the OCR packaging title. */
  packagingOcrTitle: string | null;
  /** Title-format-relevant OCR weight (DECISION-Q); null when OCR is absent. */
  ocrWeight: string | null;
  /** Title-format-relevant OCR flavor (DECISION-Q); null when OCR is absent. */
  ocrFlavor: string | null;
  /**
   * Milestone E: source-kind/provenance binding of the frozen member. A
   * distributor-record member differs in input identity from an official-page
   * member even when the title text is identical; drift in source kind,
   * generation, accepted attempts, providers, or the distributor evidence hash
   * MUST change the hash so stale evidence is never reused for titles.
   * Historical V1 members (no source-type fields) normalize to official_page.
   */
  sourceProvenance: SourceProvenanceSlice;
}

// (Moved to the pure leaf; re-exported above. Removed in Slice 6.)

// ─── Pure builder ─────────────────────────────────────────────────────────────

/**
 * The member's frozen title-relevant slice (DECISION-Q). Reused by the parent
 * op and by tests. Deliberately narrow: excludes every non-title projection
 * field (description, images, provenance, evidence/OCR authority hashes).
 */
// (Moved to the pure leaf; re-exported above. Removed in Slice 6.)

export function titleAuthorityFromProjectionMember(
  member: ExecutionEvidenceProjectionMemberV1 | ExecutionEvidenceProjectionMemberV2,
): CohortTitleAuthorityMember {
  const ocr = member.extraction.ocr.packagingOcrData;
  const brandMax = TITLE_AUTHORITY_TRUNCATION.brandMaxChars;
  const signalMax = TITLE_AUTHORITY_TRUNCATION.signalMaxChars;
  return {
    productSku: member.productSku,
    spreadsheetName: normalizeTitleAuthorityString(member.spreadsheetIdentity.name, signalMax) ?? '',
    expectedName: normalizeTitleAuthorityString(member.spreadsheetIdentity.expectedName, signalMax),
    brandHint: normalizeTitleAuthorityString(member.spreadsheetIdentity.brandHint, brandMax),
    webTitle: normalizeTitleAuthorityString(member.extraction.title, signalMax),
    webBrand: normalizeTitleAuthorityString(member.extraction.brand, brandMax),
    packagingOcrTitle: normalizeTitleAuthorityString(ocr?.productName ?? member.extraction.packagingTitle, signalMax),
    ocrWeight: normalizeTitleAuthorityString(ocr?.weight ?? null, signalMax),
    ocrFlavor: normalizeTitleAuthorityString(ocr?.flavorVariety ?? null, signalMax),
    // Milestone E: the frozen source-kind/provenance binding participates in
    // the T-hash (drift changes the input identity — stale distributor
    // evidence can never reuse title outputs).
    sourceProvenance: sourceProvenanceFromMember(member),
  };
}

// ─── Hash ─────────────────────────────────────────────────────────────────────

/**
 * Compute the canonical title input hash (T-hash) over the frozen title
 * authority: sorted-by-`onboardingItemId` member slices, the final
 * membership hash, the execution Product Type resolution, the FORMAT_RULES
 * digest, and the operation-specific model-execution authority for
 * `cohort_title_consolidation` (the frozen plan entry's provider/model/
 * versions — NO broad policy digest, PR13 DECISION-C — falling back to the
 * registry consts).
 *
 * Deterministic and pure — no DB access, no live item reads. Members are
 * sorted by onboardingItemId, so the hash is independent of input member
 * order.
 */
export function computeCohortTitleInputHash(params: CohortTitleInputHashParams): string {
  return computeCohortTitleInputHashForFormatRules(params, FORMAT_RULES);
}
/**
 * Parameterized internal: identical to `computeCohortTitleInputHash` but the
 * format-rules text is injectable, so tests can prove the FORMAT_RULES digest
 * participates without mutating the module constant.
 */
// fallow-ignore-next-line unused-export — used by tests
export function computeCohortTitleInputHashForFormatRules(
  params: CohortTitleInputHashParams,
  formatRules: string,
  // e09 title-lint (T8): injectable so tests can prove the lint version
  // participates without mutating the module constant — same shape as the
  // format-rules parameter above. Defaults to the single-sourced constant.
  titleLintVersion: string = TITLE_LINT_VERSION,
): string {
  const { run, projection, titlePlanEntry, executionTypeAuthority } = params;
  const members = [...projection.members]
    .sort((a, b) => a.onboardingItemId.localeCompare(b.onboardingItemId))
    .map(titleAuthorityFromProjectionMember);
  // PR13 review R2 (issue #30): the EXECUTED title parameters — the
  // registry's `cohort_title_consolidation` tuple (the transport applies it
  // when the caller supplies no override; the coordinator supplies none),
  // overridable only by tests. A parameter-only release changes the T-hash.
  const titleParameters =
    params.titleOperationParameters ?? OPERATION_PARAMETERS['cohort_title_consolidation'];
  return hashCanonicalJson({
    version: 2,
    kind: 'curated_title',
    familyTitleConsistencyVersion: FAMILY_TITLE_CONSISTENCY_VERSION,
    titleLintVersion,
    membership: run.finalMembershipHash,
    members,
    executionProductType: executionTypeAuthority ?? {
      id: run.executionProductTypeId,
      label: null,
      confidence: run.productTypeConfidence,
      outcome: run.productTypeOutcome,
    },
    titleFormatRulesDigest: hashCanonicalJson(formatRules),
    modelExecutionAuthority: {
      operation: 'cohort_title_consolidation',
      promptTemplateVersion:
        titlePlanEntry?.promptTemplateVersion ?? PROMPT_TEMPLATE_VERSIONS.cohort_title_consolidation,
      ruleVersion: titlePlanEntry?.ruleVersion ?? RULE_VERSIONS.cohort_title_consolidation,
      provider: titlePlanEntry?.provider ?? null,
      model: titlePlanEntry?.model ?? null,
      // PR13 review R2: the EXECUTED parameter tuple participates — a
      // parameter-only registry release (registryVersion bumped, prompt/rule
      // unchanged) must never reuse an old set across parents.
      parameters: {
        temperature: titleParameters.temperature,
        maxTokens: titleParameters.maxTokens,
      },
    },
  });
}
