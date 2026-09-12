/**
 * Cohort member execution (plan Slice 5).
 *
 * Package-internal seam, not a public workflow step. Owns the prepared-member
 * phase of a frozen cohort run: per-member resume proof, frozen input
 * construction from settled parent decisions, pipeline invocation through the
 * narrow `curatePreparedMember` entry, semantic validation, the atomic
 * member-projection commit, post-loop Brand coherence, and the owner-guarded
 * parent completion. No parent coordination from a child; no title/Page
 * transport from a prepared member — both decision sets settle before the
 * first member executes.
 *
 * Moved verbatim out of the transitional `processCohort` in Slice 5; the
 * orchestrator keeps run validation, projection parsing, frozen line-context
 * construction, and both parent decision ops, then delegates here.
 */

import { getDb } from '../../db/connection';
import {
  ensureMemberRun,
  getCohortMemberRunForTitleAudit,
  rebindMemberChildSnapshotRefs,
  getFirstCommittedMemberChildSnapshotHash,
  writeCohortBrandSemanticUpdates,
  insertProposalDependency,
  heartbeatCohortRun,
  completeCohortRun,
  COHORT_LEASE_TTL_MS,
} from '../../db/repositories/classification-cohort-run-repo';
import {
  completeRun,
  getLatestMemberChildRun,
  listChildProposalTargets,
} from '../../db/repositories/classification-run-repo';
import {
  findItemById,
  updateItemCurationData,
  updateItemStageStatus,
} from '../../db/repositories/onboarding-item-repo';
import {
  getRuntimeSnapshotByHash,
  deepFreeze,
} from '../../classification/runtime-snapshot';
import type { RuntimeClassificationSnapshot } from '../../classification/runtime-snapshot';
import {
  getEffectiveCurationTypeForSnapshot,
  resolveEffectiveTypeProfile,
} from '../../classification/effective-curation-type';
import { isUniversalAttribute } from '../../classification/applicability-evaluator';
import {
  validateMemberSemantics,
  validateMemberLocalAttributes,
  validateCohortBrandCoherence,
  mergeSemanticFindings,
  isBlockingSemanticFinding,
} from '../../classification/cohort-semantic-validator';
import type { CohortSemanticFinding } from '../../classification/cohort-semantic-validator';
import { FAMILY_TITLE_CONSISTENCY_VERSION } from '../../classification/family-title-consistency';
import { HeartbeatLostError } from '../../classification/heartbeat-errors';
import { CohortLeaseKeeper } from './execution-lease';
import { onboardingEvents } from '../sse-emitter';
import { redactTransportText } from '../../classification/model-policy-gateway';
import { modelPolicyViewFromConfig } from '../model-policy-snapshot';
import {
  buildFrozenItem,
  buildPreparedProductLineGroup,
  verifiedPageIdsFromSnapshotAuthority,
  toV2Member,
} from './frozen-evidence';
import type { FrozenProductLineContext } from './frozen-evidence';
import {
  titleInputForMember,
  selectPreparedMemberTitleInput,
} from './titles';
import type { CohortTitleOutput } from '../../shared/schemas/cohorts';
import { pageInputForMember } from './pages';
import type { CoordinatedPageMemberValue } from '../../classification/types';
import { curatePreparedMember } from '../product-curator';
import { hashCanonicalJson } from '../../shared/stable-id';
import type {
  CohortRun,
  CurationCohort,
  ExecutionEvidenceProjectionV2,
} from '../../shared/schemas/cohorts';
import type {
  CurationData,
  OnboardingItem,
} from '../../shared/schemas/onboarding';

/** One member's execution outcome (recorded, never silently dropped). */
export interface CohortMemberExecutionResult {
  itemId: string;
  productSku: string | null;
  ok: boolean;
  error: string | null;
}

/** Parent completion summary returned by member-phase execution. */
export interface CohortExecutionSummary {
  parentStatus: 'completed' | 'completed_with_abstentions' | 'completed_with_member_failures';
  completedMembers: number;
  memberCount: number;
  memberFailures: CohortMemberExecutionResult[];
}

/**
 * Test-only crash simulation signal (PR3 hardening, Commit B / R3). Thrown by
 * the `afterMemberPipeline` test seam to deterministically simulate a worker
 * crash EXACTLY between a member's pipeline completion and its atomic
 * projection commit. Like `HeartbeatLostError`, it aborts the member/cohort
 * with NO member-failure write — the child stays `running`, no
 * `curation_data_json`, no item stage write — and a reclaim re-executes the
 * member. Documented test-only (mirrors the `beforeFinalCas` freeze seam);
 * production callers never throw it.
 */
export class MemberCommitCrashSimulationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemberCommitCrashSimulationError';
  }
}

/**
 * Test-only member-phase checkpoints, threaded through the public execution
 * invocation. Production callers never pass them. (Parent decision
 * checkpoints — `afterCoordinatedCall`, `beforeTitleCopyInsert` — belong to
 * the title/Page ops and are NOT part of this interface.)
 */
export interface CohortMemberPhaseHooks {
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
}

/**
 * Execute the prepared-member phase of a frozen (`running`) cohort run.
 * Per member in ordinal order: resume-guard the committed projection, ensure
 * the freeze-created child (rebinding refs on re-execution), construct the
 * narrow prepared input from settled parent decisions, run
 * `curatePreparedMember`, validate semantics over frozen inputs, commit the
 * member projection atomically, and record failures WITHOUT aborting the
 * cohort — a member failure never stops the remaining members. Finishes with
 * post-loop Brand coherence and the owner-guarded parent completion.
 */
export async function executePreparedMembers(args: {
  run: CohortRun;
  workerId: string;
  workspacePath: string;
  workspaceId: string;
  projection: ExecutionEvidenceProjectionV2;
  cohort: CurationCohort;
  frozenLineContext: FrozenProductLineContext;
  coordinatedTitles: Map<string, CohortTitleOutput>;
  coordinatedPages: Map<string, CoordinatedPageMemberValue>;
  hooks?: CohortMemberPhaseHooks;
}): Promise<CohortExecutionSummary> {
  const {
    run,
    workerId,
    workspacePath,
    workspaceId,
    projection,
    cohort,
    frozenLineContext,
    coordinatedTitles,
    coordinatedPages,
    hooks,
  } = args;

  // PR3 hardening (Commit B / R2): cohort execution loads member identity
  // per-member (pipeline state only — id/upc/stage/status/curation data for
  // the skip rule). NO batch-wide listItemsByBatch read in the cohort path:
  // all SEMANTIC evidence comes from the frozen projection.
  const itemsById = new Map<string, OnboardingItem>();
  for (const memberProjection of projection.members) {
    const liveItem = findItemById(memberProjection.onboardingItemId);
    if (!liveItem) {
      const reason = `processCohort aborted: member item ${memberProjection.onboardingItemId} not found in batch ${cohort.batchId}.`;
      completeCohortRun(run.id, 'failed', reason, { ownerGuard: { workerId } });
      throw new Error(reason);
    }
    itemsById.set(liveItem.id, liveItem);
  }

  // The frozen projection is the authority for member ordering (ordinal).
  const orderedMembers = [...projection.members].sort((a, b) => a.ordinal - b.ordinal);
  const memberFailures: CohortMemberExecutionResult[] = [];
  let hasAbstentions = false;
  let completedMembers = 0;
  // PR9 C2 (issue #30, DECISION-A): the SKUs of members whose projection
  // committed (this attempt OR a prior committed one skipped by the resume
  // guard) — the post-loop mutual Brand coherence check runs over committed
  // members only (a member that failed without a commit has no curation data
  // to block).
  const committedMemberSkus = new Set<string>();

  // Scoped periodic heartbeat (PR3 hardening, Commit A): the lease is renewed
  // when `now - lastHeartbeatAt > COHORT_LEASE_TTL_MS / 3`, so a long
  // OCR/model/pipeline call can no longer silently outlive the TTL. `lastHeartbeatAt`
  // starts at 0 so the FIRST check always attempts a heartbeat (the lease may be
  // near expiry from the reclaim). A rejected heartbeat throws `HeartbeatLostError`.
  const HEARTBEAT_INTERVAL_MS = Math.floor(COHORT_LEASE_TTL_MS / 3);
  let lastHeartbeatAt = 0;
  const renewHeartbeat = (force = false): void => {
    if (!force && Date.now() - lastHeartbeatAt <= HEARTBEAT_INTERVAL_MS) return;
    if (!heartbeatCohortRun(run.id, workerId, COHORT_LEASE_TTL_MS)) {
      throw new HeartbeatLostError(
        `processCohort lost claim ownership of run ${run.id} (heartbeat rejected: run is no longer claimed by ${workerId} / no longer freezing or running).`,
      );
    }
    lastHeartbeatAt = Date.now();
  };

  // Deterministic abort on ownership loss: NO terminal write at all (PR3
  // hardening A2). The run now belongs to the reclaiming worker — never
  // completeCohortRun, never fail the child, never write the item. Every
  // post-await write was already guarded by the lease keeper's `assertHeld`.
  const abortOnHeartbeatLost = (err: HeartbeatLostError): never => {
    throw err;
  };

  for (const memberProjection of orderedMembers) {
    const item = itemsById.get(memberProjection.onboardingItemId)!;

    // Resume guard (crash-recovery reclaim-on-match keeps the SAME run id).
    // Recovery skip rule (PR3 hardening, Commit B / R3): a member is skipped
    // ONLY IF the child run is terminal-success AND the item's committed
    // projection references exactly that child AND the item stage is
    // completed. Otherwise the member is re-executed (a still-running child
    // with no projection commit is reused via ensureMemberRun).
    const childRow = getLatestMemberChildRun(run.id, item.id);
    const projectionCommitted =
      childRow !== undefined &&
      (childRow.status === 'completed' || childRow.status === 'completed_with_abstentions') &&
      item.curationData?.classificationRunId === childRow.id &&
      item.stageStatus === 'completed';
    if (projectionCommitted) {
      completedMembers++;
      committedMemberSkus.add(item.upc ?? item.id);
      if (childRow.status === 'completed_with_abstentions') hasAbstentions = true;
      // PR9 review R1 (B3): the resume guard skips re-execution, but it must
      // NOT lose an already-committed semantic block — a crash after a
      // committed PT/member-local blocked projection used to drop that member
      // from the parent failure summary (and complete the parent with an
      // incorrect status). Restore ONE deduplicated memberFailures entry from
      // the committed curation data before continuing (per member, one entry).
      if (item.curationData?.semanticValidation?.status === 'blocked') {
        const firstFinding = item.curationData.semanticValidation.findings[0];
        memberFailures.push({
          itemId: item.id,
          productSku: item.upc ?? null,
          ok: false,
          error: `Semantic validation blocked (run ${run.id}, member ${item.upc ?? item.id}): ` +
            `${firstFinding?.message ?? 'hard cohort semantic finding'}`,
        });
      }
      console.log(`[CohortCurator] Member ${item.upc ?? item.id} projection already committed under run ${run.id} (child ${childRow.id}) — resume guard skips re-execution.`);
      continue;
    }

    let curationData: CurationData;
    try {
      // Ownership assertion BEFORE the first member side effect (child create).
      renewHeartbeat();
      const childRun = ensureMemberRun(run.id, item.id, workspaceId, item.upc ?? '', null, null);
      if (!childRun.configSnapshotId || !childRun.configSnapshotHash) {
        // A freshly created child (re-execution after a terminal child with no
        // committed projection — R3 skip-rule recovery) inherits the
        // freeze-persisted member snapshot refs from the prior child under this
        // parent; the member runtime snapshot is immutable, so the refs are
        // exact. With no prior refs, the narrow input builder fails
        // closed below (deterministic member failure).
        // Reuse the existing refs-bearing lookup (latest refs-bearing child —
        // never the plain latest child; see `getLatestMemberChildRun`).
        const prior = getCohortMemberRunForTitleAudit(run.id, item.id);
        if (prior?.configSnapshotId && prior?.configSnapshotHash) {
          rebindMemberChildSnapshotRefs(childRun.id, prior.configSnapshotId, prior.configSnapshotHash);
          childRun.configSnapshotId = prior.configSnapshotId;
          childRun.configSnapshotHash = prior.configSnapshotHash;
        }
      }
      // Narrow prepared input (Slice 5): everything below is constructed
      // from settled parent decisions + freeze-persisted refs — never live
      // semantic state, never whole-cohort output maps.
      const memberProjectionV2 = toV2Member(memberProjection);
      if (!childRun.configSnapshotId || !childRun.configSnapshotHash) {
        throw new Error(
          `processCohort: member ${memberProjection.onboardingItemId} child run ${childRun.id} has no frozen snapshot refs.`,
        );
      }
      const memberSnapshot = getRuntimeSnapshotByHash(workspaceId, childRun.configSnapshotHash);
      if (!memberSnapshot) {
        throw new Error(
          `processCohort: frozen member runtime snapshot ${childRun.configSnapshotHash} not found for item ${memberProjection.onboardingItemId}.`,
        );
      }
      const frozenSnapshot = deepFreeze(memberSnapshot);
      // PR4 C4b: the cohort Execution Product Type is read from the parent run row
      // (written once at freeze inside the final CAS). Filled ONLY when the id is
      // non-null — flag OFF / abstained / conflicted runs leave it absent, so the
      // member pipeline never sees (or records) an execution-type context.
      const cohortExecutionType = run.executionProductTypeId !== null
        ? {
            id: run.executionProductTypeId,
            confidence: run.productTypeConfidence,
            outcome: run.productTypeOutcome,
          }
        : undefined;
      // PR5 (DECISION-H/J): resolve the member's effective Curation Product Type
      // ONCE here — reviewed facts from the member's frozen snapshot first, the
      // cohort Execution Product Type as fallback, else none.
      const resolvedEffectiveType = getEffectiveCurationTypeForSnapshot(
        frozenSnapshot,
        run.executionProductTypeId,
      );
      // The executed member is CONSTRUCTED from the frozen projection —
      // identity from the live item, every semantic field from the
      // projection (authoritative null sourceUrl stays null; NO live spread).
      const frozenItem = buildFrozenItem(memberProjectionV2, item);
      // Frozen sibling context (Commit B / R2) — attached from the
      // projection-derived line context, never from a live batch query.
      const memberSku = item.upc ?? item.id;
      const productLineGroup = buildPreparedProductLineGroup({
        productLineContext: frozenLineContext.productLineContext,
        memberGroupSizes: frozenLineContext.memberGroupSizes,
        memberUpc: item.upc,
      });
      // PR6: the durable parent-run title input for THIS member only.
      // Selection runs ONLY inside the group gate (constructed group
      // non-null) — singletons stay member-local with no selection, no
      // fallback, and no warning, exactly as the shared body did before the
      // seam move. Selection itself runs on the CONSTRUCTED item.
      const titleInput = productLineGroup !== null ? selectPreparedMemberTitleInput({
        coordinatedTitles,
        memberGroupSizes: frozenLineContext.memberGroupSizes,
        siblingSkusLength: frozenLineContext.productLineContext.siblingSkus.length,
        item: frozenItem,
        runId: childRun.id,
      }) : null;
      // PR7: the durable parent-run page input for THIS member (the P-set
      // covers groups AND singletons; a one-member map is sufficient for the
      // unchanged materializer, which reads only its own SKU's entry — the
      // slice key is the constructed item's upc, the same key the pipeline
      // input carries). A missing entry yields an empty map, exactly as the
      // whole-map read missed before.
      const pageEntry = frozenItem.upc !== null
        ? pageInputForMember(coordinatedPages, frozenItem.upc)
        : undefined;
      const memberPages = pageEntry && frozenItem.upc !== null
        ? new Map([[frozenItem.upc, pageEntry]])
        : new Map();
      const memberExtractionMethod =
        ((memberProjectionV2 as { extractionMethod?: string | null }).extractionMethod ?? null);
      // Ticket #124: frozen correction overlay (if the freeze captured one
      // for this member's open gap). Same cast pattern as extractionMethod:
      // the overlay rides the persisted projection, never a live gap read.
      const memberCorrectionOverlay =
        (memberProjectionV2 as { correctionOverlay?: { correctionHash: string; revision: number; actor: string; values: Record<string, string> } | null })
          .correctionOverlay ?? null;

      // Scoped ownership-guarded lease keeper around the long-awaited member
      // pipeline (PR3 hardening A2): the parent lease is renewed on a TTL/3
      // cadence WHILE the pipeline is in flight, the member pipeline's own
      // terminal child write is ownership-guarded via the narrow input's
      // `assertOwnershipHeld`, and the continuation re-asserts
      // ownership before EVERY member-phase write (curation_data_json, item
      // stage) — a sibling reclaim mid-pipeline aborts with NO post-loss
      // writes. The keeper is always cleared in `finally`.
      const pipelineKeeper = new CohortLeaseKeeper(run.id, workerId, COHORT_LEASE_TTL_MS).start();
      // PR9 C2 (issue #30, DECISION-A): the member's cohort semantic
      // validation result — computed from the FROZEN authority below and
      // written INSIDE the member-projection commit transaction (a crash
      // never leaves a member committed without its validation). Absent key =
      // legacy behavior.
      let semanticValidation: CurationData['semanticValidation'] = null;
      // PR9 C2/C4: the member's FROZEN runtime snapshot (the immutable ref the
      // member executed against) — resolved once above, reused by the semantic
      // validation AND the dependency-stamping universal-attribute skip below
      // (never a live config read).
      const memberSnapshotForSemantic = frozenSnapshot;
      try {
        const assertOwnershipHeld = () => pipelineKeeper.assertHeld();
        const pipelinePromise = curatePreparedMember({
          workspacePath,
          workspaceId,
          item,
          frozenItem,
          childRun,
          runtimeSnapshot: frozenSnapshot,
          modelPolicyView: frozenSnapshot.modelPolicy
            ? modelPolicyViewFromConfig(frozenSnapshot.modelPolicy as never, frozenSnapshot.snapshotHash)
            : null,
          verifiedPageIds: verifiedPageIdsFromSnapshotAuthority({
            pageImportId: frozenSnapshot.pageImportId,
            pages: frozenSnapshot.pages,
          }),
          memberProjection: memberProjectionV2,
          memberExtractionMethod,
          correctionOverlay: memberCorrectionOverlay,
          cohortExecutionType,
          effectiveType: {
            id: resolvedEffectiveType.effectiveTypeId,
            source: resolvedEffectiveType.source,
          },
          productLineGroup,
          productLineItems: frozenLineContext.productLineItems,
          titleInput,
          coordinatedPages: memberPages,
          pageCoordinationAbsent: coordinatedPages.size === 0,
          assertOwnershipHeld,
        });
        await hooks?.onPipelineInFlight?.();
        curationData = await pipelinePromise;
        // Test-only crash seam (R3): simulates a worker crash EXACTLY between
        // the member's pipeline completion and its atomic projection commit.
        // The MemberCommitCrashSimulationError is rethrown by the member catch
        // with NO member-failure write — a reclaim re-executes the member.
        await hooks?.afterMemberPipeline?.();
        // No write after ownership loss: the post-await assertion IS the guard.
        pipelineKeeper.assertHeld();

        // PR9 C2 (DECISION-A): per-member semantic validation. PURE over
        // frozen inputs — the parent Execution Product Type (run row + frozen
        // snapshot label), the durable coordinated title/page outputs already
        // selected above, the member's pipeline proposals, and the frozen
        // runtime snapshot attribute config (the SAME immutable ref the
        // member executed against — never a live config read). Hard findings
        // mark the member BLOCKED — NOT review-ready (the review completion
        // gate enforces it) — while curationData + proposals stay intact for
        // PR10's Review UX (blocked-not-destroyed). Soft findings never block.
        // Test-only seam (PR9 review R1, T1): inject a persisted pipeline
        // proposal set IMMEDIATELY before semantic validation runs — the
        // validator consumes the in-memory curation data. Production callers
        // never pass it.
        hooks?.beforeSemanticValidation?.(curationData);
        const memberSkuForSemantic = memberSku;
        const executionTypeIdForSemantic = cohortExecutionType?.id ?? null;
        const executionTypeLabelForSemantic = executionTypeIdForSemantic
          ? memberSnapshotForSemantic.productTypes.find(candidate => candidate.id === executionTypeIdForSemantic)?.name ?? null
          : null;
        const effectiveTypeIdForSemantic = resolvedEffectiveType.effectiveTypeId;
        const effectiveProfileForSemantic = effectiveTypeIdForSemantic
          ? resolveEffectiveTypeProfile(
              effectiveTypeIdForSemantic,
              memberSnapshotForSemantic.attributeProfiles,
              true,
              memberSnapshotForSemantic,
            )
          : null;
        const universalAttributeIdsForSemantic = new Set(
          memberSnapshotForSemantic.attributes
            .filter(attribute => isUniversalAttribute(attribute))
            .map(attribute => attribute.id),
        );
        const profileAttributeIdsForSemantic = effectiveProfileForSemantic
          ? new Set(effectiveProfileForSemantic.attributes.map(entry => entry.attributeId))
          : null;
        const cardinalityByAttributeForSemantic = new Map<string, 'single' | 'multiple'>(
          (effectiveProfileForSemantic?.attributes ?? [])
            .filter(entry => entry.cardinality !== undefined)
            .map(entry => [entry.attributeId, entry.cardinality]),
        );
        const durableTitleOutputForSemantic = titleInputForMember(
          coordinatedTitles,
          frozenLineContext.memberGroupSizes,
          memberSkuForSemantic,
        );
        const durablePageOutputForSemantic =
          coordinatedPages?.get(memberSkuForSemantic)?.output ?? null;
        const memberSemanticsResult = validateMemberSemantics({
          memberSku: memberSkuForSemantic,
          parentExecutionType: {
            id: executionTypeIdForSemantic,
            label: executionTypeLabelForSemantic,
          },
          curatedTitle: curationData.curatedTitle,
          titleSource: curationData.titleSource,
          suggestedPages: curationData.suggestedPages ?? [],
          // PR9 review R2 (B): the member's category_page PROPOSALS — the
          // stable Page ID is the BLOCKING page-identity comparison against
          // the durable parent page ids (pageName correspondence stays an
          // advisory diagnostic). Derived from the member pipeline result,
          // never a live page read.
          pageProposals: curationData.classificationProposals
            .filter(proposal => proposal.proposalType === 'category_page')
            .map(proposal => {
              const value = proposal.proposedValue as
                | { pageName?: unknown; pageId?: unknown }
                | null
                | undefined;
              return {
                pageId:
                  typeof proposal.targetId === 'string' && proposal.targetId.length > 0
                    ? proposal.targetId
                    : typeof value?.pageId === 'string' && value.pageId.length > 0
                      ? value.pageId
                      : null,
                pageName: typeof value?.pageName === 'string' ? value.pageName : '',
              };
            }),
          suggestedProductType: curationData.suggestedProductType,
          durableTitleOutput: durableTitleOutputForSemantic,
          durablePageOutput: durablePageOutputForSemantic,
          pageOutputExpectedEmpty: coordinatedPages.size === 0,
        });
        const memberLocalResult = validateMemberLocalAttributes({
          memberSku: memberSkuForSemantic,
          proposals: curationData.classificationProposals
            .filter(proposal => proposal.proposalType === 'field_assignment')
            .map(proposal => ({
              targetId: proposal.targetId ?? null,
              proposedValue: proposal.proposedValue,
              revisedValue: proposal.revisedValue,
              hasRevisedValue: proposal.hasRevisedValue,
            })),
          effectiveTypeId: effectiveTypeIdForSemantic,
          attributeConfig: memberSnapshotForSemantic.attributes,
          universalAttributeIds: universalAttributeIdsForSemantic,
          profileAttributeIds: profileAttributeIdsForSemantic,
          cardinalityByAttributeId: cardinalityByAttributeForSemantic,
          // PR9 review R1 (B4): the full FROZEN profile entries (carry each
          // attribute's applicabilityConditions) + the member's FROZEN/reviewed
          // facts from the immutable runtime snapshot — conditional
          // applicability is REVALIDATED with the established evaluator.
          profileEntriesByAttributeId: effectiveProfileForSemantic
            ? new Map(effectiveProfileForSemantic.attributes.map(entry => [entry.attributeId, entry]))
            : null,
          reviewedFacts: memberSnapshotForSemantic.reviewedFacts,
        });
        const semanticFindings = [
          ...memberSemanticsResult.findings,
          ...memberLocalResult.findings,
        ];
        // PR9 review R2 (B): advisory findings
        // (`coordinated_page_name_mismatch`) never block — the status
        // reflects HARD findings only.
        semanticValidation = {
          status: semanticFindings.some(isBlockingSemanticFinding) ? 'blocked' : 'passed',
          findings: semanticFindings as unknown as NonNullable<CurationData['semanticValidation']>['findings'],
        };
      } finally {
        pipelineKeeper.stop();
      }

      // ONE atomic member-projection commit (PR3 hardening, Commit B / R3):
      // curation_data_json + item stage completion + the child terminal status
      // (derived from the pipeline result) are written in ONE transaction — a
      // crash never leaves a completed child without its projection, and the
      // recovery skip rule requires all three together. PR4 C4b dependency
      // metadata rows are stamped INSIDE this same transaction, proposal-
      // accurate with SEPARATE KINDS (PR5 hardening): the child run's
      // `field_assignment` proposals — the ones the effective Curation
      // Product Type actually drives — get ONE type dependency row each,
      // `execution_product_type` when the effective type came from the cohort
      // Execution Product Type (PR5 DECISION-H, execution-source only) and
      // `reviewed_product_type` when it came from a reviewed Primary Product
      // Type. PR7 C6 (issue #30, DECISION-E): materialized `category_page`
      // proposals are ALSO genuinely type-dependent — and get ONE
      // `execution_product_type` row each with the SAME value hash — but ONLY
      // under execution-driven active-cohort mode (the parent Page op consumes
      // the cohort Execution Product Type as page context, so the materialized
      // page decision IS downstream of the type). Reviewed-driven
      // (legacy/non-cohort) `category_page` proposals stay UNSTAMPED:
      // Category Page authority there remains review-only (PR5), so the
      // reviewed effective type drives only
      // `attribute_applicability` / `product_attribute_proposals`.
      // `primary_product_type` / `configuration_gap` / `reviewable_abstention`
      // proposals are NEVER type-stamped (the type proposal is proposed from
      // member evidence and is not downstream of the effective type), and a
      // `none` member stamps nothing — so a future type change can never
      // falsely stale proposals the type did not drive. Written here (and
      // only here) means the rows exist IFF the member projection commit
      // exists — a crash before this transaction leaves zero rows, and a
      // committed projection is never missing its dependencies.
      // PR4 review fix (SHOULD-FIX 3) preserved: the stamping targets EVERY
      // `field_assignment` proposal row belonging to the child run —
      // including rows persisted by a pre-crash attempt (a crash seam can
      // leave earlier-attempt proposals on the same child run) — not just the
      // current attempt's curation-data list. The insert is idempotent
      // ((proposal_id, dependency_kind) unique + a check-then-insert), so
      // re-stamping is a no-op, and the unique index lets an
      // `execution_product_type` and a `reviewed_product_type` row coexist on
      // the same proposal (different kinds).
      const childTerminalStatus: 'completed' | 'completed_with_abstentions' =
        curationData.classificationProposals.some(p => p.proposalType === 'reviewable_abstention')
          ? 'completed_with_abstentions'
          : 'completed';
      // PR9 C2 (DECISION-A): the member's semanticValidation rides INSIDE the
      // atomic commit below — a crash never leaves a member committed without
      // its validation. Additive key: absent in legacy/shadow runs (JSON
      // stringify drops the undefined key).
      // e09 B3 (T9/P10): persist the gate-status records captured from the
      // DURABLE coordinated outputs at commit time — never recomputed from
      // live rows. A committed llm_cohort/cohort_fallback title passed
      // `validateFamilyTitleSet` before commit (the coordinator throws on an
      // invalid set, T7), so 'passed' is the only truthful status. The page
      // decision mirrors the durable output verbatim (assigned/abstained) or
      // records coordination absence. Additive keys: JSON.stringify drops
      // them when undefined, so legacy/shadow commits stay byte-identical.
      // Consumed fail-closed by the review completion gate (adjudication #8:
      // new revisions only — completed cohorts are never backfilled).
      const memberSkuForCommit = memberSku;
      const durableTitleForCommit = titleInputForMember(
        coordinatedTitles,
        frozenLineContext.memberGroupSizes,
        memberSkuForCommit,
      );
      const familyTitleValidation =
        durableTitleForCommit &&
        (durableTitleForCommit.source === 'llm_cohort' || durableTitleForCommit.source === 'cohort_fallback')
          ? {
              version: FAMILY_TITLE_CONSISTENCY_VERSION,
              status: 'passed' as const,
              source: durableTitleForCommit.source,
            }
          : undefined;
      const durablePageOutputForCommit = coordinatedPages?.get(memberSkuForCommit)?.output ?? null;
      const pageDecisionStatus = durablePageOutputForCommit
        ? durablePageOutputForCommit.status === 'abstained'
          ? { status: 'abstained' as const, reason: durablePageOutputForCommit.reason ?? null }
          : { status: 'assigned' as const }
        : { status: 'absent' as const };
      const committedCurationData: CurationData = {
        ...curationData,
        semanticValidation: semanticValidation ?? undefined,
        familyTitleValidation,
        pageDecisionStatus,
      };
      // Narrow ownership snapshot for the commit closure below.
      const commitChildRun = childRun;
      const commitCohortExecutionType = cohortExecutionType;
      const commitEffectiveSource = resolvedEffectiveType.source;
      const commitEffectiveId = resolvedEffectiveType.effectiveTypeId;
      getDb().transaction(() => {
        updateItemCurationData(item.id, JSON.stringify(committedCurationData));
        updateItemStageStatus(item.id, 'completed');
        completeRun(commitChildRun.id, childTerminalStatus);
        const execType = commitCohortExecutionType;
        // PR5 hardening (P2): proposal-accurate type dependency stamping with
        // SEPARATE KINDS. The proposals downstream of the effective Curation
        // Product Type are:
        //   - `field_assignment` proposals ALWAYS (the PR5 effective type
        //     drives `attribute_applicability` /
        //     `product_attribute_proposals`);
        //   - `category_page` proposals ONLY under active-cohort mode WITH a
        //     parent Execution Product Type (PR7 C6 + review R2 F3-1/P1-D):
        //     the parent Page op consumes the cohort Execution Product Type
        //     as page context, so the materialized page decision IS
        //     downstream of the type — REGARDLESS of `effectiveType.source`
        //     (a member whose compatible reviewed type won the effective
        //     resolution still has its page decision driven by the parent
        //     Execution Type).
        // Under each source:
        //   - source `execution` -> one `execution_product_type` row per
        //     field_assignment proposal, target = the execution type id,
        //     value hash = hashCanonicalJson({executionProductTypeId,
        //     productTypeConfidence}) (unchanged PR4 tuple — the SAME hash
        //     shape for both proposal kinds);
        //   - source `reviewed` -> one `reviewed_product_type` row per
        //     field_assignment proposal ONLY (target = the reviewed type id =
        //     the effective id — reviewed-first resolution, so the reviewed
        //     id wins over the execution id), value hash =
        //     hashCanonicalJson({reviewedProductTypeId});
        //   - source `none` -> no field rows.
        // `primary_product_type` / `configuration_gap` /
        // `reviewable_abstention` proposals get NO type dependency rows: the
        // primary-product-type proposal is proposed from member evidence and
        // is NOT downstream of the cohort Execution Type (a type change must
        // never stale the type proposal itself). `source === 'execution'`
        // implies the execution id was non-null and `execType` is defined
        // (the resolver never emits `execution` for an absent id, and
        // `cohortExecutionType` is filled exactly when the parent run carries
        // a non-null execution type id); `source === 'reviewed'` implies
        // `effectiveType.id` IS the reviewed type id.
        const executionDriven =
          commitEffectiveSource === 'execution' && commitEffectiveId !== null && execType !== undefined;
        const reviewedDriven = commitEffectiveSource === 'reviewed' && commitEffectiveId !== null;
        if (executionDriven || reviewedDriven) {
          // `field_assignment` follows `effectiveType.source` EXACTLY as
          // today (unchanged PR5 behavior).
          const dependencyKind: 'execution_product_type' | 'reviewed_product_type' =
            executionDriven ? 'execution_product_type' : 'reviewed_product_type';
          const dependencyTargetId = commitEffectiveId!;
          const dependencyValueHash = executionDriven
            ? hashCanonicalJson({
                executionProductTypeId: dependencyTargetId,
                productTypeConfidence: execType!.confidence,
              })
            : hashCanonicalJson({ reviewedProductTypeId: dependencyTargetId });
          const fieldRows = listChildProposalTargets(commitChildRun.id, 'field_assignment');
          // PR9 C4 (issue #30, DECISION-B): a `field_assignment` proposal
          // whose target attribute is UNIVERSAL (applicability is
          // type-independent) carries NO product-type dependency — the row
          // would be a false causal claim (the PR11 stale-proposal Promotion
          // gate depends on this). The attribute config is resolved from the
          // FROZEN member runtime snapshot (never a live config read);
          // type-dependent proposals keep the exact same value hash, and
          // `category_page` stamping (PR7 C6) is unchanged.
          for (const proposalRow of fieldRows) {
            const targetAttribute = proposalRow.target_id
              ? memberSnapshotForSemantic?.attributes.find(attribute => attribute.id === proposalRow.target_id)
              : undefined;
            if (targetAttribute && isUniversalAttribute(targetAttribute)) continue;
            insertProposalDependency({
              workspaceId,
              proposalId: proposalRow.id,
              dependencyKind,
              dependencyTargetId,
              dependencyValueHash,
            });
          }
        }
        // PR7 review R2 (F3-1 / P1-D): `category_page` proposals in ACTIVE
        // COHORT mode carry the `execution_product_type` dependency whenever
        // the parent Execution Product Type exists (`execType` non-null) AND
        // the parent page op produced outputs (`prepared.coordinatedPages`
        // present) — REGARDLESS of `effectiveType.source`. The effective
        // resolver is reviewed-first; a member with a compatible reviewed
        // type used to lose the page dependency even though the parent page
        // decision ALWAYS consumed the Execution Type as page context. The
        // value hash is the SAME {executionProductTypeId,
        // productTypeConfidence} tuple field_assignment uses under an
        // execution source.
        //
        // NOTE (Slice 5): the settled page set is ALWAYS present here — the
        // member phase runs only after both parent decisions settle — so the
        // `coordinatedPages !== undefined` presence check the old prepared
        // context carried is trivially true and is not re-tested.
        if (execType !== undefined && execType.id !== null) {
          const pageValueHash = hashCanonicalJson({
            executionProductTypeId: execType.id,
            productTypeConfidence: execType.confidence,
          });
          const pageRows = listChildProposalTargets(commitChildRun.id, 'category_page');
          for (const proposalRow of pageRows) {
            insertProposalDependency({
              workspaceId,
              proposalId: proposalRow.id,
              dependencyKind: 'execution_product_type',
              dependencyTargetId: execType.id,
              dependencyValueHash: pageValueHash,
            });
          }
        }
        // Test-only in-transaction seam (PR4 review SHOULD-FIX 5): fires
        // after the dependency rows are inserted, before the callback returns
        // and before the transaction commits.
        hooks?.afterMemberProjectionDependencyInsert?.();
      })();
      completedMembers++;
      committedMemberSkus.add(item.upc ?? item.id);
      if (childTerminalStatus === 'completed_with_abstentions') hasAbstentions = true;

      // PR9 C2 (DECISION-A): a HARD semantic finding blocks the member — NOT
      // review-ready (the review gate enforces it) — while the committed
      // curationData + proposals stay intact (blocked-not-destroyed). The
      // parent completes with member failures, consistent with the existing
      // member-failure summary. PR9 review R1 (SHOULD-FIX a): the failure
      // string carries run + member identity for concurrent/retried runs.
      if (semanticValidation?.status === 'blocked') {
        memberFailures.push({
          itemId: item.id,
          productSku: item.upc ?? null,
          ok: false,
          error: `Semantic validation blocked (run ${run.id}, member ${item.upc ?? item.id}): ` +
            `${semanticValidation.findings[0]?.message ?? 'hard cohort semantic finding'}`,
        });
      }

      onboardingEvents.emitItemStatus(cohort.batchId, item.id, 'completed', {
        stage: 'prepare_listing',
        cohortRunId: run.id,
        curationData: committedCurationData,
      });
      console.log(
        `[CohortCurator] ✓ Member ${item.upc ?? item.id} curated under run ${run.id}: ` +
        `title="${curationData.curatedTitle || 'N/A'}", suggestedPages=[${(curationData.suggestedPages || []).join(', ') || 'none'}]`,
      );
      // Test-only crash seam (PR9 C2): simulate a worker crash AFTER the
      // member's projection commit (between the commit and the post-loop
      // mutual Brand coherence check). The member's committed projection
      // survives; the parent stays `running`; a reclaim re-enters and the
      // post-loop brand check re-runs over the committed members.
      hooks?.afterMemberCommit?.();
    } catch (err) {
      if (err instanceof HeartbeatLostError) {
        abortOnHeartbeatLost(err);
      }
      // Simulated worker crash (test-only seam): rethrow with NO member-failure
      // write — exactly like the heartbeat-lost abort, the caller observes a
      // process crash and a reclaim re-executes the member atomically.
      if (err instanceof MemberCommitCrashSimulationError) {
        throw err;
      }
      const errorText = redactTransportText(err instanceof Error ? err.message : String(err));
      console.error(`[CohortCurator] Member ${item.upc ?? item.id} failed under run ${run.id}: ${errorText}`);
      // Ownership assertion before the item-failure write: even a general
      // (non-heartbeat) pipeline error must not write the item once the claim
      // was lost to a reclaiming worker.
      renewHeartbeat(true);
      // Record and continue — a member failure never aborts the cohort unless
      // the shared semantic state is unreachable (handled above).
      updateItemStageStatus(item.id, 'failed', errorText);
      onboardingEvents.emitItemStatus(cohort.batchId, item.id, 'failed', {
        stage: 'prepare_listing',
        cohortRunId: run.id,
        error: errorText,
      });
      memberFailures.push({ itemId: item.id, productSku: item.upc ?? null, ok: false, error: errorText });
    }
  }

  // Post-execution ownership assertion (forced): if the claim was lost while
  // processing the last member (a sibling reclaimed the lease), the parent
  // completion must not proceed — and a lost claim gets NO terminal write at
  // all (the run now belongs to the reclaiming worker).
  renewHeartbeat(true);

  // PR9 review R2 (C): resolve the FROZEN configured Brand identities from
  // the immutable runtime snapshot of the FIRST committed child (all member
  // snapshots freeze against the SAME config authority — `brands` is config
  // data, identical across members; never a live config read). The canonical
  // brand resolver compares RESOLVED BrandConfig ids, so the frozen authority
  // must be passed from the call site.
  let frozenBrandsForSemantic: RuntimeClassificationSnapshot['brands'] = [];
  {
    // ASC-first: the earliest committed child carries the canonical frozen
    // Brand authority (see the repository reader).
    const firstCommittedSnapshotHash = getFirstCommittedMemberChildSnapshotHash(run.id);
    if (firstCommittedSnapshotHash) {
      const memberSnapshotForBrands = getRuntimeSnapshotByHash(
        workspaceId,
        firstCommittedSnapshotHash,
      );
      if (memberSnapshotForBrands) frozenBrandsForSemantic = memberSnapshotForBrands.brands;
    }
  }

  // PR9 C2 (issue #30, DECISION-A): post-loop mutual Brand coherence over the
  // COMMITTED members' FROZEN brand evidence (projection-derived — never a
  // live batch read). Hard findings → owner-guarded UPDATE of each affected
  // member's `curation_data_json` (add semanticValidation status='blocked' +
  // findings — the member is NOT review-ready, the gate enforces it in PR9
  // C3) and record the member failures (the parent completes with member
  // failures per DECISION-A). curationData + proposals stay intact
  // (blocked-not-destroyed). The check re-runs on every reclaim re-entry
  // (committed members are skipped by the resume guard, the post-loop check
  // still runs) — the UPDATE is idempotent per member.
  //
  // PR9 review R1 (B2/B7): all affected members' writes are applied in ONE
  // cohort-atomic transaction whose FIRST statement is the parent lease/
  // ownership CAS (see `writeCohortBrandSemanticUpdates`) — a stale owner can
  // never write items after the claim moved, and a crash mid-loop can never
  // persist a subset. Brand findings are grouped by member SKU, each member
  // is read ONCE, and the findings are MERGED with the member's already
  // committed `semanticValidation.findings` (deterministic dedupe by
  // code+content) — a member already blocked for Product Type / title /
  // applicability / cardinality keeps those diagnostics, and at most ONE
  // parent `memberFailures` entry is recorded per member.
  const brandCoherenceResult = validateCohortBrandCoherence(
    orderedMembers
      .filter(member => committedMemberSkus.has(member.productSku ?? member.onboardingItemId))
      .map(member => ({
        sku: member.productSku ?? member.onboardingItemId,
        frozenBrandEvidence: [member.spreadsheetIdentity.brandHint, member.extraction.brand],
      })),
    // PR9 review R2 (C): the frozen configured canonical Brand identities —
    // coherence is compared on RESOLVED canonical brand ids (exact/alias/
    // prefix), never raw-grouped text.
    { brands: frozenBrandsForSemantic },
  );
  if (brandCoherenceResult.status === 'blocked') {
    // Group Brand findings by member SKU (deterministic insertion order).
    const findingsBySku = new Map<string, CohortSemanticFinding[]>();
    for (const finding of brandCoherenceResult.findings) {
      if (!findingsBySku.has(finding.memberSku)) findingsBySku.set(finding.memberSku, []);
      findingsBySku.get(finding.memberSku)!.push(finding);
    }
    const updates: Array<{ itemId: string; curationDataJson: string }> = [];
    for (const [sku, brandFindings] of findingsBySku) {
      const affectedMember = orderedMembers.find(
        member => (member.productSku ?? member.onboardingItemId) === sku,
      );
      if (!affectedMember) continue;
      const affectedItem = itemsById.get(affectedMember.onboardingItemId);
      if (!affectedItem) continue;
      // Read the member ONCE, MERGE with the committed findings (dedupe by
      // code+content), preserve blocked status + all other curation fields.
      const storedItem = findItemById(affectedItem.id);
      const existing = storedItem?.curationData ?? null;
      const mergedFindings = mergeSemanticFindings(
        existing?.semanticValidation?.findings ?? [],
        brandFindings,
      );
      const finalCurationData: CurationData = {
        ...(existing ?? ({} as CurationData)),
        semanticValidation: { status: 'blocked', findings: mergedFindings as unknown as NonNullable<CurationData['semanticValidation']>['findings'] },
      };
      updates.push({
        itemId: affectedItem.id,
        curationDataJson: JSON.stringify(finalCurationData),
      });
      // At most ONE parent member-failure entry per member (a member already
      // recorded in the loop keeps its earlier entry).
      if (!memberFailures.some(failure => (failure.productSku ?? failure.itemId) === sku)) {
        memberFailures.push({
          itemId: affectedItem.id,
          productSku: affectedItem.upc ?? null,
          ok: false,
          error: `Semantic validation blocked (run ${run.id}, member ${sku}): ` +
            `${brandFindings[0].message}`,
        });
      }
    }
    if (updates.length > 0) {
      // Cohort-atomic + owner-guarded: one transaction, lease CAS first;
      // `changes === 0` throws HeartbeatLostError and rolls the whole set
      // back (no terminal write — the reclaiming worker re-enters).
      writeCohortBrandSemanticUpdates(run.id, workerId, COHORT_LEASE_TTL_MS, updates);
      // PR9 review R1 (B7): the member-completed SSE event was emitted BEFORE
      // this post-loop Brand check — a client could have observed
      // `semanticValidation.status='passed'` and never learned the member was
      // subsequently blocked. Emit a follow-up item-status update for every
      // affected member carrying the FINAL semanticValidation.
      for (const update of updates) {
        const finalCuration = JSON.parse(update.curationDataJson) as CurationData;
        onboardingEvents.emitItemStatus(cohort.batchId, update.itemId, 'completed', {
          stage: 'prepare_listing',
          cohortRunId: run.id,
          curationData: finalCuration,
        });
      }
    }
  }

  const parentStatus = memberFailures.length > 0
    ? 'completed_with_member_failures'
    : hasAbstentions
      ? 'completed_with_abstentions'
      : 'completed';
  const errorMessage = memberFailures.length > 0
    ? `${memberFailures.length} member(s) failed: ${memberFailures
        .map(f => `${f.productSku ?? f.itemId}: ${f.error}`)
        .join('; ')
        .slice(0, 2000)}`
    : undefined;
  // Owner-guarded terminal write: only the current claim owner may complete
  // the run (a stale owner's completion is a no-op).
  completeCohortRun(run.id, parentStatus, errorMessage, { ownerGuard: { workerId } });
  console.log(
    `[CohortCurator] ✓ Cohort run ${run.id} completed with status ${parentStatus} ` +
    `(${completedMembers}/${orderedMembers.length} members)`,
  );

  // Epic #46 Phase 2 (automation-owned progression): members automatically
  // enter Review through the WORKER's poll sweep (`sweepAutoAdvance` in
  // `src/onboarding/auto-advance.ts`), which advances every curation/completed
  // member whose cohort parent is terminal and whose committed semantic
  // validation is not `blocked`. Direct `processCohort` callers (tests,
  // non-worker integrations) keep byte-identical semantics: members stay at
  // curation/completed — the committed projection state — until the worker
  // sweep advances them.
  return { parentStatus, completedMembers, memberCount: orderedMembers.length, memberFailures };
}
