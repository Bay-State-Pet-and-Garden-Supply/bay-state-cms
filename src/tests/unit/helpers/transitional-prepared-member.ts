/**
 * Transitional prepared-member test helper (plan Slice 6).
 *
 * The hand-built `PreparedCohortContext` contract and the adapter that maps
 * it onto the narrow `curatePreparedMember` entry moved verbatim out of
 * production (`cohort-curator.ts` + `product-curator.ts`). Production builds
 * the narrow input directly in `cohort-curation/members.ts`; only pre-Slice-6
 * characterization suites use this helper. Not a new public workflow API.
 */
import { getDb } from '../../../db/connection';
import { ensureMemberRun } from '../../../db/repositories/classification-cohort-run-repo';
import { getRuntimeSnapshotByHash, deepFreeze } from '../../../classification/runtime-snapshot';
import {
  buildFrozenItem,
  buildPreparedProductLineGroup,
  verifiedPageIdsFromSnapshotAuthority,
} from '../../../onboarding/cohort-curation/frozen-evidence';
import { selectPreparedMemberTitleInput } from '../../../onboarding/cohort-curation/titles';
import { pageInputForMember } from '../../../onboarding/cohort-curation/pages';
import { curatePreparedMember } from '../../../onboarding/product-curator';
import type { CuratePreparedMemberInput } from '../../../onboarding/product-curator';
import type {
  ExecutionEvidenceProjectionMember,
  ExecutionEvidenceProjectionMemberV2,
} from '../../../shared/schemas/cohorts';
import type { OnboardingItem, CurationData } from '../../../shared/schemas/onboarding';
import type { ClassificationConfigSnapshotRef } from '../../../shared/schemas/classification';
import type { ResolvedTargetOption } from '../../../classification/curation-target-resolver';
import type { PageSnapshotState } from '../../../classification/runtime-snapshot';
import type { ModelPolicyView } from '../../../classification/model-policy-gateway';
import type { ProductLineItemSnapshot, CoordinatedPageMemberValue } from '../../../classification/types';

/**
 * Prepared-cohort context consumed by `curateItemWithPipeline` (cohort mode).
 * When present the curator SKIPS authority capture, per-SKU snapshot
 * creation, stale-run cleanup and child `createRun` — it reuses the
 * freeze-created child run + persisted member runtime snapshot and builds the
 * StageContext from frozen inputs + the member projection.
 */
export interface PreparedCohortContext {
  /** Frozen member execution-evidence projection (contract C). */
  memberProjection: ExecutionEvidenceProjectionMember;
  /** Parent cohort run id (child runs link via cohort_run_id). */
  parentRunId: string;
  /** Persisted runtime snapshot refs created at freeze (child run config refs). */
  memberSnapshotId: string;
  memberSnapshotHash: string;
  /** Shared authorities captured ONCE at freeze (contract D step 2). */
  sharedAuthorities: {
    configSnapshotRef: ClassificationConfigSnapshotRef;
    pages: PageSnapshotState;
    pageImportId: string | null;
    pageImportHash: string | null;
    fieldOptions: Record<string, ResolvedTargetOption[]>;
    focusedFileHashes: Record<string, string>;
    catalogEvidenceHash: string | null;
    modelPolicyView: ModelPolicyView | null;
  };
  /**
   * Ownership assertion injected by `processCohort` (PR3 hardening A2). The
   * member pipeline calls it before its terminal child write (`completeRun`)
   * so the in-flight member work is completed only while the parent claim is
   * still held — it throws `HeartbeatLostError` once a reclaiming sibling owns
   * the run. Absent in legacy (non-cohort) invocations and when no keeper is
   * installed.
   */
  assertOwnershipHeld?: () => void;
  /**
   * Frozen product-line sibling context (PR3 hardening, Commit B / R2). Built
   * ONCE by `processCohort` via `buildFrozenProductLineContext` from the
   * persisted cohort + the FULL frozen execution-evidence projections.
   * Prepared mode consumes ONLY this — never a live `listItemsByBatch` /
   * `determineProductGroup` sibling read (a post-freeze sibling mutation is
   * never visible to title/page coordination).
   */
  productLineContext?: {
    groupId: string;
    groupLabel: string;
    siblingNames: string[];
    siblingWebTitles: string[];
    siblingOcrTitles: string[];
    siblingSkus: string[];
  };
  /** Frozen per-SKU sibling snapshots (projection-derived) for cohort page coordination. */
  productLineItems?: ProductLineItemSnapshot[];
  /**
   * PR6: the parent-run durable title outputs (persisted into
   * `classification_cohort_outputs` BEFORE the member loop by
   * `ensureCohortTitlesCoordinated`). Map productSku → {title, source}.
   * Present ONLY in active cohort mode after the parent title op; absent for
   * legacy/shadow (which keep the coordinator + cache path). Only multi-item
   * group members have entries (singletons are never coordinated — DECISION-O).
   */
  coordinatedTitles?: Map<string, { title: string; source: 'llm_cohort' | 'cohort_fallback' }>;
  /**
   * PR7 C4/C5: the parent-run durable page outputs (persisted into
   * `classification_cohort_outputs` BEFORE the member loop by
   * `ensureCohortPagesCoordinated`). Map productSku → the parsed
   * `CohortPageOutputSchema` payload PLUS the audited parent model-call id
   * that produced its row. Present ONLY in active cohort mode after the
   * parent page op; absent for legacy/shadow (which keep the coordinator
   * cache + singleton LLM path). The `category_page_proposals` stage
   * materializes these with ZERO Page LLM calls (DECISION-D). Empty when the
   * page target is disabled / no verified pages (DECISION-C expected-empty).
   */
  coordinatedPages?: Map<string, CoordinatedPageMemberValue>;
  /**
   * PR7 review R2 (F3.3): true when the parent page op chose EXPECTED-EMPTY
   * (page target enabled but NO verified pages — DECISION-C config-level
   * absence) and therefore wrote NO output rows (`coordinatedPages` is an
   * empty map BY DESIGN). The child `category_page_proposals` stage abstains
   * with the clean legacy reason instead of warning about a missing parent
   * page output. Absent for legacy/shadow and normal active cohort mode.
   */
  pageCoordinationAbsent?: boolean;
  /**
   * PR6 review fix (SHOULD-FIX 2): per-SKU ACTUAL frozen `groupByProductLine`
   * group sizes (the exact grouping the parent title op's coordinator uses),
   * attached from `FrozenProductLineContext`. The member materialization gates
   * its title branch and its missing-output fallback on THIS member's group
   * size — never the all-cohort sibling count. A true singleton (size 1) is
   * never coordinated, has no output row, and keeps the unchanged per-item
   * `name_consolidation` path (no deterministic-cohort fallback, no warning).
   * Absent in legacy/shadow mode and in hand-built test contexts (callers fall
   * back to the all-cohort sibling count).
   */
  memberGroupSizes?: Map<string, number>;
  /** Frozen member `OnboardingItem` views (projection-derived) for title coordination. */
  frozenBatchItems?: OnboardingItem[];
  /**
   * Cohort-level Execution Product Type resolved at freeze (issue #30 PR4
   * C4b). Filled by `buildPreparedCohortContextForMember` from the parent run
   * row's `execution_product_type_id` / `product_type_confidence` /
   * `product_type_outcome` — ONLY when the id is non-null (coherent /
   * coherent_with_abstentions). Absent when the flag was OFF, the cohort
   * abstained/conflicted (id stays NULL by design), or the run predates PR4.
   * Metadata only: PR4 consumes it to stamp ONE `execution_product_type`
   * dependency row per `field_assignment` proposal inside the member-projection
   * atomic commit (PR5 hardening: proposal-accurate separate kinds —
   * `execution_product_type` vs `reviewed_product_type`; only the effective
   * type's field-assignment proposals are stamped); no gate logic reads it
   * (review authority is unchanged).
   */
  cohortExecutionType?: {
    id: string | null;
    confidence: number | null;
    outcome: 'coherent' | 'coherent_with_abstentions' | 'conflicted' | 'abstained' | null;
  };
  /**
   * PR5 (DECISION-H/J): the member's effective Curation Product Type — the
   * reviewed (accepted) Primary Product Type from the frozen snapshot's
   * provenance-compatible facts first, the cohort Execution Product Type as
   * fallback, else none. Resolved ONCE in
   * `buildPreparedCohortContextForMember` via `getEffectiveCurationTypeForSnapshot`,
   * so the stages (via `StageContext.cohortExecutionType`) and the
   * member-projection dependency stamping agree by construction. A
   * non-null id with `source === 'execution'` triggers `execution_product_type`
   * dependency rows on the child run's `field_assignment` proposals (PR5
   * DECISION-H); `source === 'reviewed'` (id = the reviewed type id) triggers
   * `reviewed_product_type` rows on those same proposals (PR5 hardening —
   * separate kinds); `source === 'none'` stamps nothing. The value is exposed
   * read-only on the member's `curation_data_json` as `effectiveProductType`
   * (cohort mode only). Absent for legacy (non-cohort) invocations.
   */
  effectiveType?: { id: string | null; source: 'reviewed' | 'execution' | 'none' };
}

/**
 * Transitional adapter (Slice 5): map a hand-built prepared context onto the
 * narrow entry. Snapshot/child resolution, frozen-item construction, and
 * settled-input selection below are the pre-existing prepared-branch lines,
 * relocated unchanged — production never takes this path.
 */
async function adaptTransitionalPreparedInput(
  item: OnboardingItem,
  workspacePath: string,
  workspaceId: string,
  prepared: PreparedCohortContext,
): Promise<CuratePreparedMemberInput> {
  const frozenItem = buildFrozenItem(prepared.memberProjection, item);
  const loadedSnapshot = getRuntimeSnapshotByHash(workspaceId, prepared.memberSnapshotHash);
  if (!loadedSnapshot) {
    throw new Error(
      `Prepared-cohort mode: frozen member runtime snapshot ${prepared.memberSnapshotHash} not found; the freeze may not have persisted it.`,
    );
  }
  const runtimeSnapshot = deepFreeze(loadedSnapshot);
  const childRun = ensureMemberRun(prepared.parentRunId, item.id, workspaceId, item.upc, prepared.memberSnapshotId, prepared.memberSnapshotHash);
  if (childRun.configSnapshotId !== prepared.memberSnapshotId || childRun.configSnapshotHash !== prepared.memberSnapshotHash) {
    // Crash-recovery re-creation may have left stale refs — re-link from the
    // freeze-persisted member snapshot.
    getDb().run(
      'UPDATE classification_runs SET config_snapshot_id = ?, config_snapshot_hash = ? WHERE id = ?',
      [prepared.memberSnapshotId, prepared.memberSnapshotHash, childRun.id],
    );
  }
  // Title selection runs ONLY inside the group gate (constructed group
  // non-null) — singletons stay member-local with no selection, no
  // fallback, and no warning, exactly as the shared body did before Slice 5.
  const adapterGroup = buildPreparedProductLineGroup({
    productLineContext: prepared.productLineContext,
    memberGroupSizes: prepared.memberGroupSizes,
    memberUpc: frozenItem.upc,
  });
  const titleInput = adapterGroup !== null ? selectPreparedMemberTitleInput({
    coordinatedTitles: prepared.coordinatedTitles,
    memberGroupSizes: prepared.memberGroupSizes,
    siblingSkusLength: prepared.productLineContext?.siblingSkus.length ?? 0,
    item: frozenItem,
    runId: childRun.id,
  }) : null;
  const pageEntry = prepared.coordinatedPages !== undefined
    ? pageInputForMember(prepared.coordinatedPages, frozenItem.upc)
    : undefined;
  return {
    workspacePath,
    workspaceId,
    item,
    frozenItem,
    childRun,
    runtimeSnapshot,
    modelPolicyView: prepared.sharedAuthorities.modelPolicyView,
    verifiedPageIds: verifiedPageIdsFromSnapshotAuthority({
      pageImportId: prepared.sharedAuthorities.pageImportId,
      pages: prepared.sharedAuthorities.pages,
    }),
    memberProjection: prepared.memberProjection as ExecutionEvidenceProjectionMemberV2,
    memberExtractionMethod:
      ((prepared.memberProjection as { extractionMethod?: string | null } | null)?.extractionMethod ?? null),
    cohortExecutionType: prepared.cohortExecutionType,
    effectiveType: prepared.effectiveType,
    productLineGroup: buildPreparedProductLineGroup({
      productLineContext: prepared.productLineContext,
      memberGroupSizes: prepared.memberGroupSizes,
      memberUpc: frozenItem.upc,
    }),
    productLineItems: prepared.productLineItems,
    titleInput,
    coordinatedPages: pageEntry !== undefined
      ? (pageEntry ? new Map<string, CoordinatedPageMemberValue>([[frozenItem.upc, pageEntry]]) : new Map<string, CoordinatedPageMemberValue>())
      : undefined,
    pageCoordinationAbsent: prepared.pageCoordinationAbsent,
    assertOwnershipHeld: prepared.assertOwnershipHeld,
  };
}

/** Entry tests call: adapt a hand-built context, then run the narrow entry. */
export async function curateTransitionalPreparedMember(
  item: OnboardingItem,
  workspacePath: string,
  workspaceId: string,
  prepared: PreparedCohortContext,
): Promise<CurationData> {
  return curatePreparedMember(await adaptTransitionalPreparedInput(item, workspacePath, workspaceId, prepared));
}
