/**
 * Cohort freeze authority — capture, verification, shadow observation (Slice 1).
 *
 * The frozen-authority side of the two-phase freeze: `captureCohortAuthorities`
 * (shared authority capture), `verifyCohortRunFrozen` (the production
 * `verifyFrozen` implementation for lease reclaim), the deterministic shadow
 * observer, and the effective confidence floor. No member execution, no
 * coordination, no new source acquisition.
 *
 * Relocated verbatim from `src/onboarding/cohort-curator.ts` (Slice 1);
 * that module re-exports every moved symbol as a temporary forwarder
 * (deleted in Slice 6). Freeze composition, versions, flags, and fault
 * points are unchanged.
 */
import { getCohortById, getCohortMembers, computeMembershipHash, listCohortsByWorkspace } from '../../db/repositories/curation-cohort-repo';
import { listItemsByBatch } from '../../db/repositories/onboarding-item-repo';
import { getLatestExtractionBindingsByItemIds } from '../../db/repositories/onboarding-extraction-repo';
import { loadRuntimeConfigAuthority, createRuntimeActivationContext } from '../../classification/config-loader';
import type { RuntimeConfigAuthority } from '../../classification/config-loader';
import {
  syncConfigToCache,
  createConfigSnapshot,
  getPersistedConfigSnapshotId,
  upsertConfigSnapshot,
} from '../../db/repositories/classification-config-repo';
import { captureVerifiedPageSnapshot, toPageSnapshotState } from '../../classification/page-snapshot';
import { assertClassificationReady } from '../../classification/readiness';
import {
  buildRuntimeSnapshot,
  computeSnapshotFieldOptions,
  captureLocalVlmConfig,
  computeOcrExecutionDigest,
} from '../../classification/runtime-snapshot';
import type { PageSnapshotState } from '../../classification/runtime-snapshot';
import { buildModelPolicyView } from '../../classification/model-policy-gateway';
import type { ModelPolicyView } from '../../classification/model-policy-gateway';
import { buildModelExecutionPlan, buildRuntimeRuleVersions } from '../../classification/model-operation-registry';
import type { ModelExecutionPlan, RuntimeRuleVersions } from '../../classification/model-operation-registry';
import { getCohortCurationFlags } from '../../classification/flags';
import {
  evidenceFromProjection,
  matchMemberDeterministically,
  resolveCohortProductType,
} from '../../classification/cohort-product-type-resolver';
import type { CohortMemberInput } from '../../classification/cohort-product-type-resolver';
import { hashCanonicalJson } from '../../shared/stable-id';
import {
  buildExecutionEvidenceProjectionV3,
  buildExecutionEvidenceProjectionMember,
} from './frozen-evidence';
import { PROJECTION_VERSION_V3 } from '../../shared/schemas/cohorts';
import type { CohortRun, ExecutionProductTypeOutcome } from '../../shared/schemas/cohorts';
import type { ClassificationConfigSnapshotRef } from '../../shared/schemas/classification';
import type { ResolvedTargetOption } from '../../classification/curation-target-resolver';
// Freeze-for-execution imports (moved with the op from `../cohort-curator.ts`, Slice 6).
import { getDb } from '../../db/connection';
import { computeExtractionHash } from '../../db/repositories/curation-cohort-repo';
import {
  ensureMemberRun,
  freezeCohortRunAuthorities,
  transitionCohortRunToRunning,
  supersedeCohortRunIfUnchanged,
  persistCohortSnapshot,
  getCohortRunById,
  heartbeatCohortRun,
  writeExecutionProductType,
  writeFinalMembershipHash,
  writeProductTypeOutcomeOnly,
  failFrozenCohortRunForConflict,
  rebindMemberChildSnapshotRefs,
  COHORT_LEASE_TTL_MS,
} from '../../db/repositories/classification-cohort-run-repo';
import { findItemById, updateItemExtractionData } from '../../db/repositories/onboarding-item-repo';
import { getOcrStageFlags } from '../../classification/ocr-stage-flags';
import { runPackagingOcrStageForFreeze } from '../../classification/stages/packaging-ocr-stage';
import { completeRun, createRun, childRunHasSideEffects } from '../../db/repositories/classification-run-repo';
import {
  persistRuntimeSnapshot,
  requireModelCallContext,
  getModelExecutionPlanEntry,
  buildModelCallContext,
} from '../../classification/runtime-snapshot';
import type { RuntimeClassificationSnapshot } from '../../classification/runtime-snapshot';
import type { ModelCallContext } from '../../classification/model-operation-registry';
import { modelPolicyViewFromConfig } from '../model-policy-snapshot';
import { mapRankedLabelToOptionExactlyOne } from '../../classification/cohort-product-type-resolver';
import type {
  CohortProductTypeResolution,
  ConfidentMemberProductTypeResult,
  MemberLlmRankResult,
} from '../../classification/cohort-product-type-resolver';
import { resolveTargetsFromSnapshot } from '../../classification/curation-target-resolver';
import { getReviewedTypeFromSnapshot } from '../../classification/effective-curation-type';
import { buildEvidenceTargetPacket } from '../../classification/evidence-targeting';
import { llmRankOptions } from '../../classification/curation-target-ranker';
import { HeartbeatLostError } from '../../classification/heartbeat-errors';
import { CohortLeaseKeeper } from './execution-lease';
import { getVlmConfig } from '../vlm-client';
import { runPackagingOcrAttempt, mergeOcrResults } from '../packaging-ocr';
import {
  computeOcrInputHash,
  storedOcrInputHash,
  storedOcrExecutionDigest,
  isOcrSettled,
  hasOcrContent,
  invalidateStaleStoredOcr,
  parseFreezeOcrRerunCap,
} from './frozen-evidence';
import { canonicalJsonStringify } from '../../shared/stable-id';
import type { CurationCohortMember } from '../../shared/schemas/cohorts';
import type { OnboardingItem, PackagingOcrData, OcrAttemptOutcome } from '../../shared/schemas/onboarding';

const now = () => new Date().toISOString();

/**
 * Effective cohort Product Type confidence floor (PR4 architecture-report §7).
 * A member's resolved type contribution must clear this floor to count as a
 * confident cohort contribution (the per-member matcher's own
 * `KEYWORD_MATCH_MIN_CONFIDENCE` gate still applies first). Read per call
 * from the runtime flags so the env override
 * (`BAYSTATE_CMS_COHORT_PRODUCT_TYPE_CONFIDENCE_FLOOR`, default 0.7 — see
 * `src/classification/flags.ts` → `cohortProductTypeConfidenceFloor`) applies
 * without a redeploy; the freeze integration AND the shadow observer both use
 * this effective value.
 */
export function cohortProductTypeConfidenceFloor(): number {
  return getCohortCurationFlags().cohortProductTypeConfidenceFloor;
}

// ─── Shared authority capture (contract D step 2, once per freeze) ────────────

export interface CohortFreezeAuthorities {
  authority: RuntimeConfigAuthority;
  configSnapshotRef: ClassificationConfigSnapshotRef;
  focusedFileHashes: Record<string, string>;
  catalogEvidenceHash: string | null;
  pages: PageSnapshotState;
  pageImportId: string | null;
  pageImportHash: string | null;
  /** Frozen once at cohort freeze (D7) — injected into every member snapshot. */
  fieldOptions: Record<string, ResolvedTargetOption[]>;
  /** Unbound model-policy view (no snapshotHash binding — the digest is
   *  identical across members). */
  modelPolicyView: ModelPolicyView | null;
  modelExecutionPlan: ModelExecutionPlan | null;
  runtimeRuleVersions: RuntimeRuleVersions | null;
  /** H5 combined digest over the full frozen execution authority. */
  modelExecutionDigest: string | null;
}

/**
 * Capture the common authorities ONCE for a cohort freeze. FAILS CLOSED for an
 * ACTIVE v2 authority whose bundle hash has no persisted
 * `classification_config_snapshots` row — `config_snapshot_id` may NOT be null
 * when v2 (the run row must reference the persisted snapshot). Page identity
 * comes from `captureVerifiedPageSnapshot` (transactional, bijective,
 * fail-closed). H5 = `hashCanonicalJson({ policyDigest,
 * modelExecutionPlanDigest, runtimeRuleVersionsDigest })` over the SAME frozen
 * inputs the per-member runtime snapshots are built from.
 */
export function captureCohortAuthorities(
  workspacePath: string,
  workspaceId: string,
): CohortFreezeAuthorities {
  const activationContext = createRuntimeActivationContext(workspacePath, workspaceId);
  const authority = loadRuntimeConfigAuthority(workspacePath, activationContext);
  const pageSnapshot = captureVerifiedPageSnapshot(workspaceId);
  assertClassificationReady(authority, {
    catalogFields: activationContext.catalogFields,
    verifyCatalogEvidence: activationContext.verifyCatalogEvidence,
    verifiedPageIds: pageSnapshot.pageImportId ? pageSnapshot.verifiedPageIds : [],
  });

  let configSnapshotRef: ClassificationConfigSnapshotRef;
  let focusedFileHashes: Record<string, string>;
  let catalogEvidenceHash: string | null;
  if (authority.kind === 'v2') {
    const bundle = authority.bundle;
    let persistedId = getPersistedConfigSnapshotId(workspaceId, bundle.manifest.bundleHash);
    if (!persistedId) {
      const snap = upsertConfigSnapshot(workspaceId, bundle, bundle.manifest.sourceCatalogCommit);
      persistedId = snap.id;
    }
    configSnapshotRef = {
      id: persistedId,
      hash: bundle.manifest.bundleHash,
      sourceCommit: bundle.manifest.sourceCatalogCommit,
      createdAt: now(),
    };
    focusedFileHashes = bundle.manifest.fileVersions;
    catalogEvidenceHash = bundle.manifest.catalogEvidenceHash;
  } else {
    try {
      syncConfigToCache(workspaceId, authority.config);
    } catch (err) {
      console.warn(`[CohortCurator] Failed to sync config to cache: ${err instanceof Error ? err.message : String(err)}`);
    }
    const { id, hash } = createConfigSnapshot(workspaceId, authority.config);
    configSnapshotRef = { id, hash, sourceCommit: null, createdAt: now() };
    focusedFileHashes = authority.config.manifest.fileVersions ?? {};
    catalogEvidenceHash = null;
  }

  const config = authority.kind === 'v2'
    ? (authority.bundle as unknown as Parameters<typeof computeSnapshotFieldOptions>[0])
    : authority.config;
  const fieldOptions = computeSnapshotFieldOptions(config);

  const modelPolicyView = authority.kind === 'v2'
    ? buildModelPolicyView(authority.bundle.modelPolicy)
    : null;
  const modelExecutionPlan = modelPolicyView
    ? buildModelExecutionPlan(modelPolicyView, captureLocalVlmConfig())
    : null;
  const runtimeRuleVersions = modelPolicyView ? buildRuntimeRuleVersions() : null;
  const modelExecutionDigest = modelPolicyView && modelExecutionPlan && runtimeRuleVersions
    ? hashCanonicalJson({
        policyDigest: modelPolicyView.policyDigest,
        modelExecutionPlanDigest: modelExecutionPlan.digest,
        runtimeRuleVersionsDigest: runtimeRuleVersions.digest,
      })
    : null;

  return {
    authority,
    configSnapshotRef,
    focusedFileHashes,
    catalogEvidenceHash,
    pages: toPageSnapshotState(pageSnapshot),
    pageImportId: pageSnapshot.pageImportId,
    pageImportHash: pageSnapshot.pageImportHash,
    fieldOptions,
    modelPolicyView,
    modelExecutionPlan,
    runtimeRuleVersions,
    modelExecutionDigest,
  };
}

// ─── Frozen verification (lease-reclaim match/drift) ─────────────────────────

export function verifyCohortRunFrozen(
  run: CohortRun,
  workspacePath: string,
  workspaceId: string,
): boolean {
  try {
    if (run.evidenceSnapshotHash === null) {
      // Crash mid-freeze (nothing finalized yet) → resume and re-freeze — but
      // only a run that is STILL a live `freezing` claim. A terminal
      // NULL-hash run (cancelled/failed/superseded) is never a vacuous match.
      return run.status === 'freezing';
    }
    const cohort = getCohortById(run.cohortId);
    if (!cohort || cohort.status !== 'ready' || cohort.supersededAt !== null) return false;
    const members = getCohortMembers(cohort.id);
    if (computeMembershipHash(members.map(member => member.onboardingItemId)) !== run.candidateMembershipHash) return false;
    if (cohort.membershipHash !== run.candidateMembershipHash) return false;

    const items = listItemsByBatch(cohort.batchId);
    const extractionSources = getLatestExtractionBindingsByItemIds(members.map(member => member.onboardingItemId));
    const projection = buildExecutionEvidenceProjectionV3(workspaceId, cohort, members, items, extractionSources);
    if (hashCanonicalJson(projection) !== run.evidenceSnapshotHash) return false;

    const current = captureCohortAuthorities(workspacePath, workspaceId);
    if (run.configSnapshotHash !== null && current.configSnapshotRef.hash !== run.configSnapshotHash) return false;
    if (run.pageImportHash !== null && current.pageImportHash !== run.pageImportHash) return false;
    if (run.modelPolicyDigest !== null && current.modelExecutionDigest !== run.modelPolicyDigest) return false;
    return true;
  } catch {
    // Any capture/build failure (page snapshot drift, config load error,
    // missing item, projection validation) is a drift verdict — never resume
    // against an unverifiable freeze.
    return false;
  }
}

// ─── PR4 C5: shadow-mode deterministic-only resolution (DECISION-E) ───────────

/** One member's contribution to a shadow observation (PR4 C5). */
export interface CohortShadowObservationMember {
  onboardingItemId: string;
  productSku: string | null;
  productTypeId: string | null;
  /** 'reviewed' when a compatible reviewed type drives the contribution,
   *  'keyword' when the deterministic matcher produced the match, 'llm' when
   *  the run-bound ranker did, 'none' for an abstention (shadow never invokes
   *  the LLM ranker — DECISION-E). */
  source: 'reviewed' | 'keyword' | 'llm' | 'none';
}

/** One ready cohort's deterministic-only Execution Product Type observation. */
export interface CohortShadowObservation {
  cohortId: string;
  outcome: ExecutionProductTypeOutcome;
  perMember: CohortShadowObservationMember[];
}

/**
 * PR4 C5 shadow-mode observation (architecture-report §7, DECISION-E).
 *
 * Runs the DETERMINISTIC-ONLY cohort Execution Product Type resolver
 * (`evidenceFromProjection` + `matchMemberDeterministically` +
 * `resolveCohortProductType`, the C3 pure module) over every READY,
 * non-superseded cohort in the workspace, from the CURRENT world (members →
 * items → extraction sources → frozen evidence projections). Member runtime
 * snapshots are built IN-MEMORY (never persisted) purely to resolve the
 * product type options from the current config authority — the same evidence
 * the freeze-time active-mode resolution consumes, minus any model calls.
 *
 * Write NOTHING and invoke NO model calls:
 * - no `execution_product_type_id` / `product_type_confidence` /
 *   `product_type_outcome` / `final_membership_hash` writes — run rows are
 *   never created or mutated;
 * - no `classification_proposal_dependencies` rows;
 * - the LLM ranker is never invoked (`memberLlmResults` stays empty — shadow
 *   measures the deterministic outcome only; LLM-vs-deterministic divergence
 *   is exactly the metric shadow should surface).
 *
 * Shadow OCR is NEVER a reusable authority (PR12 C5, DECISION-D): the
 * in-memory member snapshots are never persisted (no `persistRuntimeSnapshot`,
 * no evidence snapshot), the freeze's OCR pull-forward
 * (`runFrozenOcrPullForward` / `updateItemExtractionData`) is NEVER invoked,
 * and no OCR authority marker (packagingOcrData / ocrOutcome / ocrInputHash /
 * ocrExecutionDigest) is written into `extraction_data_json`. Shadow observes
 * the CURRENT world read-only; an OCR result produced under shadow flags
 * therefore can never be reused as an execution authority by a later freeze.
 *
 * PR13 C4 (issue #30, documented nuance): the v1 synthetic-snapshot
 * FALSE-NEGATIVE. For v1 (legacy) member snapshots `computeOcrExecutionDigest`
 * binds the digest to the snapshot's CONTENT IDENTITY
 * (`hashCanonicalJson({authorityKind:'v1', snapshotHash})`). The shadow
 * observer builds its member snapshots IN-MEMORY via `buildRuntimeSnapshot`
 * with placeholder config refs, so the synthetic snapshot's hash — and thus
 * its expected OCR digest — differs from the snapshot hash the stored OCR
 * was actually verified against. The PR12 R1 predicate therefore REJECTS
 * otherwise-CURRENT v1 OCR from the shadow evidence: a conservative
 * FALSE NEGATIVE (shadow under-reports OCR participation), NEVER a
 * stale-authority FALSE POSITIVE (shadow never blesses stale OCR). The
 * freeze path is unaffected (it re-verifies against the real snapshot refs).
 * Belongs with future shadow-observability work (a shadow authority that
 * reproduces the frozen digest instead of the synthetic one); documented
 * here as conservative safety by design.
 *
 * The caller (worker poll leg) invokes this ONLY under
 * `cohortCurationV2Enabled && cohortShadowOnly`; flag OFF / active mode stay
 * byte-identical (this function is simply not called). Returns the
 * observations so tests can assert the computed outcome without parsing
 * logs; the caller logs the `cohort_product_type_shadow` line.
 */
export function observeCohortShadowTypeResolution(
  workspaceId: string,
  workspacePath: string,
): CohortShadowObservation[] {
  const observations: CohortShadowObservation[] = [];
  const readyCohorts = listCohortsByWorkspace(workspaceId).filter(
    cohort => cohort.status === 'ready' && cohort.supersededAt === null,
  );
  if (readyCohorts.length === 0) return observations;

  // The CURRENT config authority (read-only): member snapshots resolve the
  // same product type options a freeze would freeze.
  const activationContext = createRuntimeActivationContext(workspacePath, workspaceId);
  const authority = loadRuntimeConfigAuthority(workspacePath, activationContext);
  const confidenceFloor = cohortProductTypeConfidenceFloor();

  for (const cohort of readyCohorts) {
    try {
      const members = getCohortMembers(cohort.id);
      if (members.length === 0) continue;
      const items = listItemsByBatch(cohort.batchId);
      const itemsById = new Map(items.map(item => [item.id, item]));
      const extractionSources = getLatestExtractionBindingsByItemIds(members.map(member => member.onboardingItemId));

      const memberInputs: CohortMemberInput[] = [];
      for (const member of members) {
        const item = itemsById.get(member.onboardingItemId);
        if (!item) continue;
        const memberProjection = buildExecutionEvidenceProjectionMember(
          member,
          item,
          extractionSources.get(item.id),
        );
        // In-memory snapshot — never persisted; only the product-type option
        // resolution path is consumed by the resolver.
        const snapshot = buildRuntimeSnapshot({
          workspaceId,
          workspacePath,
          productSku: item.upc ?? '',
          authority,
          configSnapshotRef: { id: '', hash: '', sourceCommit: null, createdAt: '' },
          sourceProductHash: '',
        });
        // PR12 review R1: the CURRENT OCR execution-authority digest for this
        // in-memory snapshot — the observer is READ-ONLY: persisted OCR whose
        // stored `ocrExecutionDigest` was computed under an OLDER authority is
        // rejected from the shadow evidence (never re-run, never written). A
        // matching digest may participate read-only.
        const expectedOcrExecutionDigest = computeOcrExecutionDigest(snapshot);
        memberInputs.push({ projection: memberProjection, memberSnapshot: snapshot, expectedOcrExecutionDigest });
      }
      if (memberInputs.length === 0) continue;

      // PR12 C5 (DECISION-D) explicit guard assertion: shadow mode builds
      // member snapshots IN-MEMORY only — they are never persisted, and the
      // OCR pull-forward (the ONLY OCR write path in the curator,
      // `runFrozenOcrPullForward` → `updateItemExtractionData`) is never
      // invoked here (the shadow-flagged freeze also SKIPS it — see
      // `freezeCohortForExecution`). A shadow-mode OCR result can therefore
      // never reach `extraction_data_json` and never becomes a reusable
      // authority (evidence snapshot / OCR hash). Asserting the in-memory
      // placeholder config ref proves nothing was persisted (a persisted
      // snapshot would carry a real id/hash pair).
      for (const input of memberInputs) {
        if (input.memberSnapshot.configSnapshotRef.id !== '' || input.memberSnapshot.configSnapshotRef.hash !== '') {
          throw new Error(
            'Shadow observation invariant violated: a member snapshot was persisted (shadow never persists snapshots or OCR).',
          );
        }
      }

      // DECISION-E: deterministic-only — no `memberLlmResults`, so the
      // run-bound LLM ranker is never invoked in shadow mode.
      const resolution = resolveCohortProductType({ confidenceFloor, members: memberInputs });
      observations.push({
        cohortId: cohort.id,
        outcome: resolution.outcome,
        perMember: resolution.perMember.map(member => ({
          onboardingItemId: member.onboardingItemId,
          productSku: member.productSku,
          productTypeId: member.productTypeId,
          source: member.source,
        })),
      });
    } catch (err) {
      // Shadow observation is best-effort: a cohort that cannot be projected
      // (e.g. mid-refresh membership) is skipped, never fatal.
      console.warn(`[CohortCurator] Shadow type resolution failed for cohort ${cohort.id} (non-blocking):`, err);
    }
  }
  return observations;
}

// ─── Freeze for execution (moved verbatim from `../cohort-curator.ts`, Slice 6) ───

// ─── OCR pull-forward (contract D5 / amendment 5) ─────────────────────────────

/**
 * Run ONE run-bound OCR attempt for a member (frozen plan route,
 * start-before-transport provenance via `classification_model_calls` on the
 * member child run — mirroring product-evidence-extractor.ts:756-766 /
 * :834-843 with `requireModelCallContext` from the member's persisted
 * snapshot). Mirrors the extractor's local → cloud fallback with the frozen
 * data-sharing policy; the result is written back to
 * `extraction_data_json` by the caller together with the `ocrInputHash` the
 * attempt was started against. Exported for the exactly-once OCR tests.
 */
export async function runFrozenOcrPullForward(params: {
  snapshot: RuntimeClassificationSnapshot;
  childRunId: string;
  item: OnboardingItem;
  workspacePath: string;
  /**
   * Ownership assertion (PR3 hardening C) forwarded to the OCR transport's
   * terminal model-call updates. Run-bound cohort calls pass the scoped lease
   * keeper's `assertHeld`; legacy/absent → the transport is unchanged.
   */
  assertHeld?: () => void;
}): Promise<{ packagingOcrData: PackagingOcrData | null; ocrOutcome: OcrAttemptOutcome;
  /** P2 drift-guard: WHO authored the persisted live keys — 'stage' means the
   *  delegated stage wrote them (marker packagingOcrStageRunId must be set to
   *  childRunId by the caller's write-back); 'legacy' means this body did
   *  (the write-back must CLEAR any stale marker so dual-run comparisons
   *  never mistake legacy output for stage output). */
  authoredBy: 'stage' | 'legacy'; }> {
  // P2-T6 (packaging-OCR overhaul, ordered consumer migration — producer
  // FIRST): when the packaging_ocr stage master flag is ON **and shadow-only
  // mode is OFF**, the freeze DELEGATES its OCR moment to the stage
  // (`runPackagingOcrStageForFreeze`). Shadow-only delegation is excluded:
  // under master ON + shadow ON (the defaults) the stage's output can never
  // become authoritative, so delegating here would either leave the freeze
  // without live OCR keys or silently promote a shadow result — instead the
  // freeze stays on THIS legacy pull-forward while the pipeline-level stage
  // still runs in shadow via `composeCurationPipelineStages`. The freeze
  // remains the authoritative OCR moment when delegation IS active: ALL
  // caller-side gating below (settled / input-hash / digest-staleness /
  // re-run cap), the scoped lease keeper, and the hash/digest binding
  // write-back are untouched. Flag OFF (default) executes THIS legacy body
  // byte-identically. Items that are not materialized DB rows (direct
  // synthetic callers) stay on the legacy path — the stage resolves its
  // inputs from the persisted row.
  const ocrStageFlags = getOcrStageFlags();
  if (
    ocrStageFlags.packagingOcrStageEnabled
    && !ocrStageFlags.packagingOcrStageShadowOnly
    && params.item.id
    && findItemById(params.item.id)
  ) {
    const staged = await runPackagingOcrStageForFreeze(params);
    return { ...staged, authoredBy: 'stage' as const };
  }
  const { snapshot, childRunId, item, workspacePath } = params;
  const sku = item.upc;
  const ext: Record<string, any> = item.extractionData ?? {};

  const vlmConfig = getVlmConfig();
  const canUseLocalVlm = vlmConfig?.enabled === true;
  const dataPolicy = snapshot.dataSharing as { textPolicy?: string; imagePolicy?: string } | undefined;
  const canUseCloudImages = dataPolicy?.imagePolicy === 'cloud_allowed';

  let localStatus: OcrAttemptOutcome['status'] = canUseLocalVlm ? 'skipped' : 'disabled';
  let cloudStatus: OcrAttemptOutcome['status'] = canUseCloudImages ? 'skipped' : 'disabled';
  // P1-T5 fixup: persist the coded local failure reason + transport attempt
  // count on ordinary (non-ownership) failures so production consumers
  // observe WHY the local leg failed instead of a bare 'failed'.
  let localFailureReason: import('../../shared/schemas/onboarding').OcrFailureReason | null = null;
  let localAttempts = 0;

  const imageUrls: string[] = [];
  if (ext.primaryImage) imageUrls.push(String(ext.primaryImage));
  if (Array.isArray(ext.additionalImages)) {
    for (const img of ext.additionalImages) {
      if (imageUrls.length >= 2) break;
      if (img && String(img).trim()) imageUrls.push(String(img));
    }
  }

  const ocrResults: PackagingOcrData[] = [];
  let packagingOcrData: PackagingOcrData | undefined;
  let localOcrSucceeded = false;

  if (canUseLocalVlm) {
    localStatus = imageUrls.length > 0 ? 'failed' : 'no_image';
    // Frozen evidence-extraction policy view + run-bound call context ONCE.
    const evidencePolicyView = modelPolicyViewFromConfig(
      snapshot.modelPolicy as Parameters<typeof modelPolicyViewFromConfig>[0],
      snapshot.snapshotHash,
    );
    let localModelCall: ModelCallContext | null = null;
    let localFrozenRoute: { baseUrl: string; model: string } | null = null;
    try {
      localModelCall = requireModelCallContext(snapshot, childRunId, 'evidence_extraction', 1);
      const entry = getModelExecutionPlanEntry(snapshot, 'evidence_extraction');
      if (entry?.localVlmBaseUrl && entry?.localVlmModel) {
        localFrozenRoute = { baseUrl: entry.localVlmBaseUrl, model: entry.localVlmModel };
      }
    } catch (err) {
      localStatus = 'failed';
      console.warn(
        `[CohortCurator] Freeze OCR pull-forward for SKU ${sku} abstained: no compatible frozen plan — ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    for (let i = 0; i < imageUrls.length; i++) {
      const imgUrl = imageUrls[i];
      // No compatible plan → no transport, no evidence from the model call.
      if (!localModelCall) continue;
      try {
        const attempt = await runPackagingOcrAttempt({
          imageUrl: imgUrl,
          workspacePath,
          imageSourceUrl: imgUrl,
          sku,
          modelCall: localModelCall,
          snapshot,
          frozenVlmRoute: localFrozenRoute,
          modelPolicyDigest: evidencePolicyView?.policyDigest ?? '',
          assertHeld: params.assertHeld,
        });
        if (attempt.ok) {
          if (hasOcrContent(attempt.data)) ocrResults.push(attempt.data);
        } else {
          localFailureReason = attempt.reasonCode;
          localAttempts = Math.max(localAttempts, attempt.attempts);
        }
      } catch (err) {
        // PR3 hardening C: an ownership assertion failure during the transport's
        // terminal update aborts the freeze IMMEDIATELY — no further images or
        // writes from the stale owner.
        if (err instanceof HeartbeatLostError) throw err;
        console.warn(`[CohortCurator] Freeze OCR failed for image ${i + 1}/${imageUrls.length} of SKU ${sku}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (ocrResults.length > 0) {
      const merged = ocrResults.length === 1 ? ocrResults[0] : mergeOcrResults(ocrResults);
      if (hasOcrContent(merged)) {
        localOcrSucceeded = true;
        localStatus = 'succeeded';
        packagingOcrData = merged;
      }
    }
  }

  // Cloud multimodal VLM fallback (runs if local OCR did not succeed).
  if (!localOcrSucceeded && ext.primaryImage && canUseCloudImages) {
    cloudStatus = 'failed';
    try {
      const evidencePolicyView = modelPolicyViewFromConfig(
        snapshot.modelPolicy as Parameters<typeof modelPolicyViewFromConfig>[0],
        snapshot.snapshotHash,
      );
      const { extractPackagingOcrFromCloud } = await import('../cloud-vlm-client');
      let cloudModelCall: ModelCallContext | null = null;
      try {
        cloudModelCall = requireModelCallContext(snapshot, childRunId, 'evidence_extraction', 1);
      } catch (err) {
        cloudStatus = 'failed';
        cloudModelCall = null;
        console.warn(
          `[CohortCurator] Freeze cloud OCR pull-forward for SKU ${sku} abstained: no compatible frozen plan — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (cloudModelCall) {
        const cloudOcrResult = await extractPackagingOcrFromCloud({
          imageUrl: String(ext.primaryImage),
          modelPolicy: evidencePolicyView,
          modelCall: cloudModelCall,
          snapshot,
        });
        if (cloudOcrResult && hasOcrContent(cloudOcrResult)) {
          packagingOcrData = cloudOcrResult;
          cloudStatus = 'succeeded';
        }
      }
    } catch (err) {
      // PR3 hardening C: same immediate-abort rule for the cloud fallback.
      if (err instanceof HeartbeatLostError) throw err;
      console.warn(`[CohortCurator] Freeze cloud packaging OCR failed for SKU ${sku}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const overallStatus: OcrAttemptOutcome['status'] =
    localStatus === 'succeeded' || cloudStatus === 'succeeded'
      ? 'succeeded'
      : imageUrls.length === 0
        ? 'no_image'
        : !canUseLocalVlm && !canUseCloudImages
          ? 'disabled'
          : 'failed';

  const ocrOutcome: OcrAttemptOutcome = {
    status: overallStatus,
    localStatus,
    cloudStatus,
    model: packagingOcrData?.metadata?.model ?? vlmConfig?.model ?? null,
    imageCount: imageUrls.length,
    ...(localFailureReason ? { localFailureReason } : {}),
    ...(localAttempts > 0 ? { attempts: localAttempts } : {}),
  };
  return { packagingOcrData: packagingOcrData ?? null, ocrOutcome, authoredBy: 'legacy' as const };
}

// ─── Two-phase freeze service (contract D) ────────────────────────────────────

/** Internal CAS drift signal — rolled back and handled outside the transaction. */
class CohortFreezeCasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CohortFreezeCasError';
  }
}

/** Internal ownership signal — the run is no longer ours to finalize. */
class CohortFreezeOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CohortFreezeOwnershipError';
  }
}

// (Relocated to `classification-run-repo.childRunHasSideEffects`; re-exported
//  via the Slice 1→6 forwarders. Removed in Slice 6.)

export interface FreezeMemberResult {
  member: CurationCohortMember;
  item: OnboardingItem;
  extractionSourceUrl: string | null;
  /** ocrInputHash the (possibly pulled-forward) OCR was started against. */
  frozenOcrInputHash: string;
  /** Member-local evidence hash after OCR pull-forward. */
  frozenEvidenceHash: string;
  snapshot: RuntimeClassificationSnapshot;
  runtimeSnapId: string;
  runtimeSnapHash: string;
  memberRunId: string;
}

/**
 * Deterministic structured conflict reason for a conflicted cohort Product
 * Type resolution (PR4 architecture-report §4 / DECISION-D): per-member ids +
 * SKUs + the distinct confident ids, written into the run's `error_message`
 * when the run completes `failed`. Members are sorted by onboardingItemId so
 * the message is stable across retries. PR5 hardening (P1-2): reviewed ids
 * participate as family-invariant contributions — the per-member detail
 * carries the reviewed type id when present and the header lists every
 * reviewed type involved. Never majority-forced; no type is written on
 * conflict.
 *
 * PR13 (issue #30, DECISION-D): the distinct/reviewed SUMMARIES render the
 * configured LABEL beside the deterministic id (`dry-dog-food (Dry Dog
 * Food)`) — resolved from the FROZEN member snapshot's `productTypes`
 * (`{id, name}`; unknown ids render id-only). The member DETAIL lines keep
 * the RAW ids unchanged (the deterministic machine-readable contract).
 */
function buildCohortProductTypeConflictReason(
  resolution: Extract<CohortProductTypeResolution, { outcome: 'conflicted' }>,
  productTypes: ReadonlyArray<{ id: string; name: string }>,
): string {
  const labelFor = (id: string): string => {
    const name = productTypes.find(pt => pt.id === id)?.name;
    return name ? `${id} (${name})` : id;
  };
  const confident = resolution.perMember.filter(
    (m): m is ConfidentMemberProductTypeResult => !m.isAbstention,
  );
  // PR5 hardening (P1-2): the distinct id set is the union of contribution
  // ids AND raw confident inferences — a reviewed-first projection must never
  // hide the inferred side of a reviewed-vs-inference family conflict.
  const distinctIds = [...new Set([
    ...confident.map(m => m.productTypeId),
    ...resolution.perMember.map(m => m.inferredTypeId).filter((id): id is string => id !== null),
  ])].sort((a, b) => a.localeCompare(b));
  const reviewedIds = [...new Set(
    resolution.perMember.map(m => m.reviewedTypeId).filter((id): id is string => id !== null),
  )].sort((a, b) => a.localeCompare(b));
  const detail = [...resolution.perMember]
    .sort((a, b) => a.onboardingItemId.localeCompare(b.onboardingItemId))
    .map(m => {
      const inferredNote = m.inferredTypeId && m.inferredTypeId !== m.productTypeId
        ? ` (inferred:${m.inferredTypeId})`
        : '';
      return `${m.onboardingItemId}${m.productSku ? ` (${m.productSku})` : ''} -> ${m.productTypeId ?? 'abstained'}@${(m.confidence ?? 0).toFixed(3)}${m.reviewedTypeId ? ` (reviewed:${m.reviewedTypeId})` : ''}${inferredNote}`;
    })
    .join('; ');
  const reviewedNote = reviewedIds.length > 0
    ? `; reviewed types: ${reviewedIds.map(labelFor).join(', ')}`
    : '';
  return `cohort_product_type_conflict: ${distinctIds.length} distinct confident Product Types (${distinctIds.map(labelFor).join(', ')}); members: ${detail}${reviewedNote}; no execution type written (family conflict, never majority-forced).`;
}

/**
 * Confidence equality with a tiny epsilon: `product_type_confidence` is a REAL
 * column whose value may be re-derived from the keyword matcher's float
 * arithmetic (`0.45 + score * 0.35`), so a re-stored value can differ from the
 * freshly computed one in the last ulp. Genuinely different confidences are
 * still caught (the epsilon is 1e-9).
 */
function confidenceCloseTo(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= 1e-9;
}

/**
 * PR4 review fix (SHOULD-FIX 4): when a write-once shared-semantic write
 * no-ops during freeze finalization, the run must NOT be blessed into
 * `running` with a mismatched tuple. Reload the stored tuple and require it
 * to equal the freshly resolved `{id, confidence, outcome}`; when
 * `final_membership_hash` is already set it must equal the candidate
 * membership hash (and for a conflicted outcome — which finalizes nothing —
 * the hash slot must stay NULL). Any mismatch throws `CohortFreezeCasError`:
 * the caller supersedes the run (fail-closed, no execution from an incoherent
 * run; the cohort stays ready for a fresh claim).
 */
function assertStoredExecutionTypeMatches(
  runId: string,
  expected: { id: string | null; confidence: number | null; outcome: ExecutionProductTypeOutcome },
  expectedFinalMembershipHash: string | null,
): void {
  const stored = getCohortRunById(runId);
  if (!stored) {
    throw new CohortFreezeCasError(`run ${runId} disappeared during the shared semantic commit.`);
  }
  if (stored.productTypeOutcome !== expected.outcome) {
    throw new CohortFreezeCasError(
      `run ${runId} already carries product_type_outcome '${stored.productTypeOutcome}' but the fresh resolution is '${expected.outcome}' — refusing to finalize an incoherent run.`,
    );
  }
  if (stored.executionProductTypeId !== expected.id) {
    throw new CohortFreezeCasError(
      `run ${runId} already carries execution_product_type_id '${stored.executionProductTypeId}' but the fresh resolution is '${expected.id}' — refusing to finalize an incoherent run.`,
    );
  }
  if (!confidenceCloseTo(stored.productTypeConfidence, expected.confidence)) {
    throw new CohortFreezeCasError(
      `run ${runId} already carries product_type_confidence ${stored.productTypeConfidence} but the fresh resolution is ${expected.confidence} — refusing to finalize an incoherent run.`,
    );
  }
  const storedHash = stored.finalMembershipHash;
  if (expectedFinalMembershipHash === null) {
    if (storedHash !== null) {
      throw new CohortFreezeCasError(
        `run ${runId} already carries final_membership_hash ${storedHash} but the fresh resolution is conflicted — nothing may be finalized.`,
      );
    }
  } else if (storedHash !== null && storedHash !== expectedFinalMembershipHash) {
    throw new CohortFreezeCasError(
      `run ${runId} already carries final_membership_hash ${storedHash} but the candidate membership hash is ${expectedFinalMembershipHash} — refusing to finalize an incoherent run.`,
    );
  }
}

/**
 * Freeze a claimed cohort for execution (the ONLY path to `freezing →
 * running`). Returns the run in its final state:
 * - `running` on success (authorities + snapshot persisted, transitioned);
 * - `superseded` when the final CAS detects drift (children failed);
 * Throws for ownership loss / unexpected errors.
 *
 * `hooks.beforeFinalCas` (test seam) runs immediately before the final CAS
 * transaction so tests can deterministically simulate a freeze-window
 * mutation; `hooks.onOcrInFlight` (test seam, PR3 hardening A2) fires while a
 * member's OCR pull-forward transport is actually in flight so tests can
 * deterministically simulate a sibling reclaim mid-call; `hooks.onTypeRankerInFlight`
 * (test seam, PR4 re-review fix) fires while a member's `product_type_ranking`
 * LLM transport is genuinely in flight so tests can deterministically simulate
 * a sibling reclaim mid-ranking-call; `hooks.beforeCasSupersede`
 * (test seam, PR4 review fix) fires in the CAS-drift handler immediately
 * before the owner-guarded supersede attempt so tests can deterministically
 * simulate a sibling reclaim between the failed CAS and the supersede;
 * `hooks.beforeConflictTerminal` (test seam, PR4 re-review fix P1-2) fires
 * inside the final CAS immediately before the owner-guarded conflict terminal
 * write so tests can deterministically simulate a sibling reclaim between
 * conflict detection and the helper (the helper must no-op).
 * Production callers never pass any.
 */
export async function freezeCohortForExecution(
  run: CohortRun,
  workspacePath: string,
  workspaceId: string,
  hooks?: {
    beforeFinalCas?: () => void;
    onOcrInFlight?: () => void | Promise<void>;
    onTypeRankerInFlight?: () => void | Promise<void>;
    beforeCasSupersede?: () => void;
    beforeConflictTerminal?: () => void;
  },
): Promise<CohortRun> {
  const workerId = run.claimedBy ?? '';
  if (!workerId) {
    throw new Error(`Freeze aborted: run ${run.id} has no claim owner.`);
  }
  if (run.status !== 'freezing') {
    // Fail fast: a non-freezing run (already running/superseded/…) can never
    // be re-frozen. The final CAS ownership guard would reject it anyway;
    // reject up front so callers cannot mistake a no-op for progress.
    throw new Error(`Freeze aborted: run ${run.id} is not in 'freezing' state (status=${run.status}).`);
  }

  // PR4 C4a gate: the Execution Product Type resolver + LLM ranker fallback
  // run ONLY in active mode (`cohortCurationV2Enabled && !cohortShadowOnly`).
  // Flag OFF / shadow: freeze is byte-identical to PR3 — zero resolver
  // invocations, zero model calls, zero writes to the PR4 columns.
  const cohortCurationFlags = getCohortCurationFlags();
  const cohortTypeResolutionActive = cohortCurationFlags.cohortCurationV2Enabled
    && !cohortCurationFlags.cohortShadowOnly;

  // 1. Load the candidate cohort + members + items + extraction sources.
  const cohort = getCohortById(run.cohortId);
  if (!cohort || cohort.status !== 'ready' || cohort.supersededAt !== null) {
    throw new Error(`Freeze aborted: cohort ${run.cohortId} is not a ready candidate (status=${cohort?.status ?? 'missing'}).`);
  }
  const members = getCohortMembers(cohort.id);
  if (members.length === 0) {
    throw new Error(`Freeze aborted: cohort ${cohort.id} has no members.`);
  }
  const items = listItemsByBatch(cohort.batchId);
  const itemsById = new Map(items.map(item => [item.id, item]));
  for (const member of members) {
    if (!itemsById.has(member.onboardingItemId)) {
      throw new Error(`Freeze aborted: member item ${member.onboardingItemId} not found in batch ${cohort.batchId}.`);
    }
  }
  const extractionSources = getLatestExtractionBindingsByItemIds(members.map(member => member.onboardingItemId));
  const membershipHash = computeMembershipHash(members.map(member => member.onboardingItemId));
  if (membershipHash !== run.candidateMembershipHash) {
    throw new Error(`Freeze aborted: cohort membership changed since claim (candidate ${run.candidateMembershipHash}, current ${membershipHash}).`);
  }

  // 2. Capture the common authorities ONCE (config/page/policy/H5/fieldOptions).
  const captured = captureCohortAuthorities(workspacePath, workspaceId);

  // 3–4. Per member: snapshot (frozen fieldOptions) + persist + child run +
  //      OCR pull-forward + recompute hash. The parent lease is heartbeated
  //      at member granularity (TTL/3 cadence) so a multi-member freeze with
  //      long OCR calls stays inside the TTL; a rejected heartbeat aborts the
  //      freeze (a sibling owns the run now — no further side effects).
  const frozenMembers: FreezeMemberResult[] = [];
  // PR4 C4a: per-member run-bound LLM ranker results (DECISION-A), aligned
  // with `frozenMembers` — null when the member's deterministic keyword match
  // was confident, or the LLM fallback was skipped / unavailable (fail-closed
  // abstention). Empty (never populated) when the resolver is inactive.
  const memberTypeLlmResults: Array<MemberLlmRankResult | null> = [];
  let lastHeartbeatAt = 0;
  // P1-T3 stampede guard: per-cohort-freeze cap on digest-staleness OCR
  // re-runs. Only members actually re-run count; members beyond the cap keep
  // their stale marker and remain unsettled — they pick up on a later pass.
  // Re-runs triggered by OTHER fail-closed causes (never-settled OCR,
  // input-hash change, null digests) are unchanged legacy behavior and are
  // never capped.
  const freezeOcrRerunCap = parseFreezeOcrRerunCap(process.env.BAYSTATE_CMS_FREEZE_OCR_RERUN_CAP);
  let ocrStalenessReruns = 0;
  for (const member of members) {
    if (Date.now() - lastHeartbeatAt > COHORT_LEASE_TTL_MS / 3) {
      if (!heartbeatCohortRun(run.id, workerId, COHORT_LEASE_TTL_MS)) {
        throw new HeartbeatLostError(
          `freeze lost claim ownership of run ${run.id} (heartbeat rejected; run no longer claimed by ${workerId} / no longer freezing).`,
        );
      }
      lastHeartbeatAt = Date.now();
    }
    const item = itemsById.get(member.onboardingItemId)!;
    const extractionSourceUrl = extractionSources.get(item.id)?.sourceUrl ?? null;
    const currentOcrInputHash = computeOcrInputHash(item, extractionSourceUrl);

    const snapshot = buildRuntimeSnapshot({
      workspaceId,
      workspacePath,
      productSku: item.upc,
      authority: captured.authority,
      configSnapshotRef: captured.configSnapshotRef,
      focusedFileHashes: captured.focusedFileHashes,
      catalogEvidenceHash: captured.catalogEvidenceHash,
      fieldOptions: captured.fieldOptions,
      sourceProductHash: '',
      searchKeywords: item.extractionData?.searchKeywords ? String(item.extractionData.searchKeywords) : null,
      productPageNames: [],
      pages: captured.pages,
      pageImportId: captured.pageImportId,
      pageImportHash: captured.pageImportHash,
    });

    // Defensive: the member plan/rules must match the shared H5 components the
    // cohort run will record (identical inputs ⇒ identical digests).
    if (captured.authority.kind === 'v2') {
      if (!snapshot.modelExecutionPlan || !snapshot.runtimeRuleVersions) {
        throw new Error(`Freeze aborted: member ${item.id} snapshot lacks a frozen model-execution plan.`);
      }
      if (snapshot.modelExecutionPlan.digest !== captured.modelExecutionPlan?.digest ||
          snapshot.runtimeRuleVersions.digest !== captured.runtimeRuleVersions?.digest) {
        throw new Error(`Freeze aborted: member ${item.id} snapshot plan digest drifted from the shared H5 authority.`);
      }
    }

    const { id: runtimeSnapId, hash: runtimeSnapHash } = persistRuntimeSnapshot(snapshot);
    let memberRun = ensureMemberRun(run.id, item.id, workspaceId, item.upc, runtimeSnapId, runtimeSnapHash);
    if (memberRun.configSnapshotId !== runtimeSnapId || memberRun.configSnapshotHash !== runtimeSnapHash) {
      // Reusing an existing RUNNING child whose snapshot refs differ from the
      // freshly built snapshot (a prior partial freeze captured the child
      // under a DIFFERENT authority). If the child already accumulated
      // model-call/stage side effects, rebinding it would stamp new
      // provenance onto old work — retire it and create a NEW child under the
      // same parent with the new snapshot. With no side effects the refs are
      // updated in place (idempotent ensureMemberRun may have returned a run
      // created by a prior partial freeze with stale refs).
      if (childRunHasSideEffects(memberRun.id)) {
        completeRun(memberRun.id, 'failed', 'snapshot changed during resume');
        memberRun = createRun(workspaceId, item.upc, runtimeSnapId, runtimeSnapHash, {
          onboardingItemId: item.id,
          cohortRunId: run.id,
        });
      } else {
        rebindMemberChildSnapshotRefs(memberRun.id, runtimeSnapId, runtimeSnapHash);
      }
    }

    // OCR pull-forward: run ONE run-bound OCR call when the stored OCR is
    // unsettled, OR its recorded input set no longer matches the current one,
    // OR its execution-authority digest no longer matches the CURRENT
    // snapshot's plan/rule digest (R4: old OCR under a changed model policy /
    // local-VLM route is NEVER accepted — it re-runs under the new authority).
    // Fail-closed (Commit A2): reuse requires BOTH digests non-null AND equal
    // — a stored OCR with a missing/uncomputable authority (pre-hardening
    // v1/v2 data) is never accepted, it re-runs under the current authority.
    // PR12 C5 (DECISION-D): shadow-mode OCR is NEVER a reusable authority.
    // Shadow mode is observe-only — the worker never claims cohorts and never
    // invokes this freeze (job-queue.ts), so the pull-forward is unreachable
    // under shadow in production. The guard makes the invariant STRUCTURAL: a
    // shadow-flagged freeze SKIPS the pull-forward instead of writing a
    // shadow-mode OCR result (packagingOcrData / packagingTitle / ocrOutcome /
    // ocrInputHash / ocrExecutionDigest) into `extraction_data_json`, where it
    // would become a reusable authority (evidence snapshot / OCR hash).
    const currentOcrExecutionDigest = computeOcrExecutionDigest(snapshot);
    const storedExecutionDigest = storedOcrExecutionDigest(item);
    const ocrNeedsRun =
      !isOcrSettled(item) ||
      storedOcrInputHash(item) !== currentOcrInputHash ||
      currentOcrExecutionDigest === null ||
      storedExecutionDigest === null ||
      storedExecutionDigest !== currentOcrExecutionDigest;
    // P1-T3 digest-staleness trigger: a stored OCR bound to a DIFFERENT
    // execution authority is never silently discarded. It is invalidated with
    // a visible marker FIRST (prior data preserved), then re-run under the
    // new authority below so fresh data + fresh digest bind atomically at the
    // existing write site. Beyond the per-freeze cap the marker stays and the
    // member remains visibly unsettled until a later pass.
    const ocrDigestStale =
      storedExecutionDigest !== null &&
      currentOcrExecutionDigest !== null &&
      storedExecutionDigest !== currentOcrExecutionDigest;
    let frozenItem = item;
    if (ocrDigestStale && !cohortCurationFlags.cohortShadowOnly) {
      frozenItem = invalidateStaleStoredOcr(item);
    }
    if (
      ocrNeedsRun
      && !cohortCurationFlags.cohortShadowOnly
      && (!ocrDigestStale || ocrStalenessReruns < freezeOcrRerunCap)
    ) {
      if (ocrDigestStale) ocrStalenessReruns += 1;
      // Scoped ownership-guarded lease keeper around the long-awaited OCR
      // call (PR3 hardening A2): the parent lease is renewed on a TTL/3
      // cadence WHILE the transport is in flight (a live-but-slow owner can
      // no longer silently outlive the lease), and the continuation asserts
      // ownership BEFORE the extraction_data_json write-back — a sibling
      // reclaim mid-call aborts the freeze with NO post-loss write. The
      // keeper is always cleared in `finally`.
      const ocrKeeper = new CohortLeaseKeeper(run.id, workerId, COHORT_LEASE_TTL_MS).start();
      try {
        const ocrPromise = runFrozenOcrPullForward({
          snapshot,
          childRunId: memberRun.id,
          item,
          workspacePath,
          // PR3 hardening C: the OCR transport asserts ownership immediately
          // before every terminal model-call update — a sibling reclaim
          // mid-transport skips the terminal write and aborts the freeze.
          assertHeld: () => ocrKeeper.assertHeld(),
        });
        await hooks?.onOcrInFlight?.();
        const ocr = await ocrPromise;
        // No write after ownership loss: the post-await assertion IS the guard.
        ocrKeeper.assertHeld();
        // PR3 hardening C (2a): a re-run outcome ALWAYS replaces the stored
        // OCR — packagingOcrData/packagingTitle are overwritten UNCONDITIONALLY
        // (null when the re-run produced no usable OCR). Old-authority OCR is
        // NEVER preserved and re-stamped with the new digest: an authority-
        // mismatch re-run that returns no usable OCR clears A's data instead of
        // stamping it as B's.
        const updatedExt = {
          ...item.extractionData,
          packagingOcrData: ocr.packagingOcrData ?? null,
          packagingTitle: ocr.packagingOcrData?.productName ?? null,
          ...(ocr.ocrOutcome ? { ocrOutcome: ocr.ocrOutcome } : {}),
          ocrInputHash: currentOcrInputHash,
          ocrExecutionDigest: currentOcrExecutionDigest,
          // P2 drift-guard marker lifecycle: the write-back rebuilds from the
          // PRE-call extraction snapshot, so without this the marker written
          // by delegated-stage persistence would be dropped (or a stale one
          // restored). Stage-authored ⇒ bind to THIS member run; legacy-
          // authored ⇒ clear (JSON.stringify drops undefined keys).
          ...(ocr.authoredBy === 'stage'
            ? { packagingOcrStageRunId: memberRun.id }
            : { packagingOcrStageRunId: undefined }),
        };
        updateItemExtractionData(item.id, JSON.stringify(updatedExt));
        frozenItem = { ...item, extractionData: updatedExt as OnboardingItem['extractionData'] };
      } finally {
        ocrKeeper.stop();
      }
    }

    const frozenEvidenceHash = computeExtractionHash(frozenItem);
    if (!frozenEvidenceHash) {
      throw new Error(`Freeze aborted: member ${item.id} has no extraction hash after OCR pull-forward.`);
    }

    // PR4 C4a per-member Execution Product Type resolution (active flags
    // only — flag OFF / shadow skips this block entirely): frozen evidence →
    // deterministic keyword match → run-bound LLM ranker fallback (DECISION-A:
    // `product_type_ranking` on the member child run, exactly like the member
    // SKU stage's `processTargetInternal`) when the deterministic match is
    // below the cohort confidence floor. A failing/unavailable LLM path
    // abstains (fail-closed — no silent type from a failed model path). NO
    // writes here; the per-member results feed the final CAS aggregation.
    let memberTypeLlmResult: MemberLlmRankResult | null = null;
    if (cohortTypeResolutionActive) {
      const memberProjection = buildExecutionEvidenceProjectionMember(member, frozenItem, extractionSources.get(item.id));
      const typeEvidence = evidenceFromProjection(memberProjection);
      const resolvedTypeTarget = resolveTargetsFromSnapshot(snapshot).productTypes[0] ?? null;
      const typeOptions = resolvedTypeTarget?.options ?? [];
      const deterministicTypeMatch = matchMemberDeterministically(typeEvidence, typeOptions);
      const belowFloor =
        deterministicTypeMatch.productTypeId === null ||
        deterministicTypeMatch.confidence === null ||
        deterministicTypeMatch.confidence < cohortProductTypeConfidenceFloor();
      if (belowFloor && resolvedTypeTarget !== null && typeOptions.length > 0) {
        const typePacket = buildEvidenceTargetPacket(typeEvidence, {
          attributeId: null,
          sourceField: null,
          selectionMode: 'single',
        });
        if (typePacket.promptText.trim().length >= 8) {
          // PR4 re-review fix (P1-1): the freeze-time `product_type_ranking`
          // fallback runs under a scoped CohortLeaseKeeper EXACTLY like the
          // OCR pull-forward above — the parent lease is renewed while the
          // ranking transport is in flight, and the continuation asserts
          // ownership before any further work. A sibling reclaim mid-call
          // aborts the freeze with NO post-loss side effect. The keeper is
          // always cleared in `finally`.
          const rankerKeeper = new CohortLeaseKeeper(run.id, workerId, COHORT_LEASE_TTL_MS).start();
          try {
            const rankedPromise = llmRankOptions({
              targetLabel: resolvedTypeTarget.config.label,
              options: typeOptions,
              selectionMode: 'single',
              evidenceText: typePacket.promptText,
              task: 'product_type_classification',
              modelPolicy: snapshot.modelPolicy
                ? modelPolicyViewFromConfig(snapshot.modelPolicy as never, snapshot.snapshotHash)
                : null,
              protectedOperation: 'product_type_ranking',
              modelCall: buildModelCallContext(snapshot, memberRun.id, 'product_type_ranking', 1),
              snapshot,
              // The ranker asserts ownership immediately before every
              // terminal-preflight row and around every awaited transport
              // call — a rejected assertion throws `HeartbeatLostError`.
              assertHeld: () => rankerKeeper.assertHeld(),
            });
            await hooks?.onTypeRankerInFlight?.();
            const ranked = await rankedPromise;
            // No write after ownership loss: the post-await assertion IS the guard.
            rankerKeeper.assertHeld();
            if (ranked && ranked.values.length > 0) {
              // PR4 review fix (BLOCKER): `llmRankOptions` prompts and
              // normalizes exclusively against option LABELS; the persisted
              // `execution_product_type_id` must be the option's canonical
              // VALUE (pt.id). Map the returned label back through this
              // member's FROZEN typeOptions; if no exact label maps the
              // member abstains (fail closed — never an id guessed from a
              // display label). `resolveCohortProductType` applies the same
              // defensive mapping to its `memberLlmResults` input.
              const llmLabel = ranked.values[0];
              // PR4 review fix (SHOULD-FIX): duplicate Product Type display
              // labels are permitted by config validation, so a label matching
              // TWO frozen options is ambiguous — the member must abstain
              // (fail closed), never silently pick the first match. Exactly
              // one matching option maps the label to its canonical VALUE.
              const mappedId = mapRankedLabelToOptionExactlyOne(llmLabel, typeOptions);
              memberTypeLlmResult = mappedId !== null
                ? { productTypeId: mappedId, confidence: ranked.confidence }
                : null;
            }
            // No valid LLM values / no LLM config / no frozen policy → the
            // member abstains (fail-closed).
          } catch (err) {
            // Ownership-loss exceptions are NEVER converted into an 'LLM
            // unavailable → abstain' outcome: the stale owner must abort the
            // freeze deterministically with no further side effects.
            if (err instanceof HeartbeatLostError) throw err;
            // Policy denial / transport failure → abstain, never a silent type.
            memberTypeLlmResult = null;
          } finally {
            rankerKeeper.stop();
          }
        }
      }
    }
    memberTypeLlmResults.push(memberTypeLlmResult);

    frozenMembers.push({
      member,
      item: frozenItem,
      extractionSourceUrl,
      frozenOcrInputHash: currentOcrInputHash,
      frozenEvidenceHash,
      snapshot,
      runtimeSnapId,
      runtimeSnapHash,
      memberRunId: memberRun.id,
    });
  }

  // 5. FINAL CAS TRANSACTION — reload + verify + persist + transition in ONE
  //    transaction. OCR ran OUTSIDE this transaction. The test seam hook runs
  //    right before the transaction so a freeze-window mutation can be
  //    simulated deterministically.
  hooks?.beforeFinalCas?.();
  const finalize = (): CohortRun => {
    const db = getDb();
    return db.transaction(() => {
      const reloadedCohort = getCohortById(run.cohortId);
      if (!reloadedCohort || reloadedCohort.status !== 'ready' || reloadedCohort.supersededAt !== null) {
        throw new CohortFreezeCasError(`cohort ${run.cohortId} is no longer a ready candidate (status=${reloadedCohort?.status ?? 'missing'}).`);
      }
      const reloadedMembers = getCohortMembers(run.cohortId);
      const reloadedMembershipHash = computeMembershipHash(reloadedMembers.map(member => member.onboardingItemId));
      if (reloadedMembershipHash !== run.candidateMembershipHash || reloadedCohort.membershipHash !== run.candidateMembershipHash) {
        throw new CohortFreezeCasError(`cohort membership changed during the freeze window (candidate ${run.candidateMembershipHash}, current ${reloadedMembershipHash}).`);
      }
      const reloadedItems = listItemsByBatch(reloadedCohort.batchId);
      const reloadedItemsById = new Map(reloadedItems.map(item => [item.id, item]));
      const reloadedExtractionSources = getLatestExtractionBindingsByItemIds(reloadedMembers.map(member => member.onboardingItemId));

      // (c) each member's CURRENT evidence hash + ocrInputHash still match the
      // frozen values captured during the freeze window.
      for (const frozen of frozenMembers) {
        const currentItem = reloadedItemsById.get(frozen.member.onboardingItemId);
        if (!currentItem) {
          throw new CohortFreezeCasError(`member ${frozen.member.onboardingItemId} disappeared during the freeze window.`);
        }
        const currentEvidenceHash = computeExtractionHash(currentItem);
        if (!currentEvidenceHash || currentEvidenceHash !== frozen.frozenEvidenceHash) {
          throw new CohortFreezeCasError(`member ${frozen.member.onboardingItemId} evidence changed during the freeze window (frozen hash ${frozen.frozenEvidenceHash}, current ${currentEvidenceHash ?? 'none'}).`);
        }
        const currentExtractionSource = reloadedExtractionSources.get(currentItem.id)?.sourceUrl ?? null;
        const currentOcrInputHash = computeOcrInputHash(currentItem, currentExtractionSource);
        if (currentOcrInputHash !== frozen.frozenOcrInputHash) {
          throw new CohortFreezeCasError(`member ${frozen.member.onboardingItemId} input set changed during the freeze window (ocrInputHash mismatch).`);
        }
      }

      // (d) config/page/policy digests unchanged since capture.
      const currentAuthorities = captureCohortAuthorities(workspacePath, workspaceId);
      if (currentAuthorities.configSnapshotRef.hash !== captured.configSnapshotRef.hash) {
        throw new CohortFreezeCasError('configuration authority changed during the freeze window.');
      }
      if (currentAuthorities.pageImportHash !== captured.pageImportHash) {
        throw new CohortFreezeCasError('Page catalog authority changed during the freeze window.');
      }
      if (currentAuthorities.modelExecutionDigest !== captured.modelExecutionDigest) {
        throw new CohortFreezeCasError('model-execution authority changed during the freeze window.');
      }

      // Build + persist the content-addressed execution-evidence projection.
      const projection = buildExecutionEvidenceProjectionV3(
        workspaceId,
        reloadedCohort,
        reloadedMembers,
        reloadedItems,
        reloadedExtractionSources,
      );
      const payloadJson = canonicalJsonStringify(projection);
      const h2 = hashCanonicalJson(projection);
      const persisted = persistCohortSnapshot({
        workspaceId,
        snapshotHash: h2,
        projectionVersion: PROJECTION_VERSION_V3,
        payloadJson,
      });

      // Write H1–H5 + evidence_snapshot_id, then transition — ownership guarded.
      const frozen = freezeCohortRunAuthorities(run.id, workerId, {
        evidenceSnapshotId: persisted.id,
        evidenceSnapshotHash: h2,
        configSnapshotId: captured.configSnapshotRef.id,
        configSnapshotHash: captured.configSnapshotRef.hash,
        pageImportId: captured.pageImportId,
        pageImportHash: captured.pageImportHash,
        modelPolicyDigest: captured.modelExecutionDigest,
      });
      if (!frozen) {
        throw new CohortFreezeOwnershipError(`Freeze CAS lost ownership of run ${run.id} (not freezing / claimed by ${workerId}).`);
      }

      // PR4 C4a: freeze-time Execution Product Type resolution + write-once
      // final-membership hash — the shared semantic commit (DECISION-B, inside
      // the final CAS transaction). Only in active mode; flag OFF / shadow
      // never invokes the resolver (zero new writes, byte-identical PR3).
      let typeResolution: CohortProductTypeResolution | null = null;
      if (cohortTypeResolutionActive) {
        const memberProjectionByItemId = new Map(projection.members.map(m => [m.onboardingItemId, m]));
        typeResolution = resolveCohortProductType({
          confidenceFloor: cohortProductTypeConfidenceFloor(),
          members: frozenMembers.map(fm => {
            const memberProjection = memberProjectionByItemId.get(fm.member.onboardingItemId);
            if (!memberProjection) {
              throw new CohortFreezeCasError(`member ${fm.member.onboardingItemId} missing from the frozen execution-evidence projection.`);
            }
            return {
              projection: memberProjection,
              memberSnapshot: fm.snapshot,
              // PR5 hardening (P1-2): the member's compatible reviewed
              // Primary Product Type from its frozen snapshot's
              // provenance-compatible reviewed facts participates in the
              // cohort coherence rules at freeze time (a reviewed type that
              // differs from a confident inference — or another member's
              // reviewed type — conflicts; an agreeing reviewed type
              // contributes with source 'reviewed'; a reviewed type may
              // resolve an otherwise-abstaining member).
              reviewedTypeId: getReviewedTypeFromSnapshot(fm.snapshot),
            };
          }),
          memberLlmResults: memberTypeLlmResults,
        });
        if (typeResolution.outcome === 'coherent' || typeResolution.outcome === 'coherent_with_abstentions') {
          // Write-once CAS: a second write (re-entrant freeze / pre-written
          // run) is a no-op — an existing execution type is never overwritten.
          const typeWritten = writeExecutionProductType(run.id, workerId, {
            executionProductTypeId: typeResolution.productTypeId,
            productTypeConfidence: typeResolution.confidence,
            productTypeOutcome: typeResolution.outcome,
          });
          const hashWritten = writeFinalMembershipHash(run.id, workerId, run.candidateMembershipHash);
          // PR4 review fix (SHOULD-FIX 4): a no-op write must not bless a
          // mismatched prewritten tuple as finalized. Reload the stored tuple
          // and require it to equal the fresh resolution (+ the candidate
          // membership hash when the hash slot is already taken); any
          // mismatch throws CohortFreezeCasError and the run is superseded —
          // it never transitions to `running` from an incoherent state.
          if (!typeWritten || !hashWritten) {
            assertStoredExecutionTypeMatches(
              run.id,
              {
                id: typeResolution.productTypeId,
                confidence: typeResolution.confidence,
                outcome: typeResolution.outcome,
              },
              run.candidateMembershipHash,
            );
          }
        } else if (typeResolution.outcome === 'abstained') {
          const outcomeWritten = writeProductTypeOutcomeOnly(run.id, workerId, 'abstained');
          // Abstention still finalizes membership (no family invariant to
          // violate) — final membership = candidate membership.
          const hashWritten = writeFinalMembershipHash(run.id, workerId, run.candidateMembershipHash);
          if (!outcomeWritten || !hashWritten) {
            assertStoredExecutionTypeMatches(
              run.id,
              { id: null, confidence: null, outcome: 'abstained' },
              run.candidateMembershipHash,
            );
          }
        } else {
          // Conflicted: record the outcome ONLY. The execution type id stays
          // NULL (never majority-forced) and final_membership_hash is NOT
          // written (nothing is finalized); the run completes `failed` below.
          const outcomeWritten = writeProductTypeOutcomeOnly(run.id, workerId, 'conflicted');
          if (!outcomeWritten) {
            assertStoredExecutionTypeMatches(run.id, { id: null, confidence: null, outcome: 'conflicted' }, null);
          }
        }
      }

      // PR4 re-review fix (P1-2): a conflicted family NEVER passes through
      // `running` — the parent transitions freezing → failed DIRECTLY via the
      // owner-guarded helper (started_at stays NULL; no transition to running
      // ever happens), which atomically terminalizes every freeze-created
      // child run of this parent in the same transaction. The run stays the
      // current historical decision, the cohort stays ready, and the operator
      // resolves the family later (no UI in PR4). If the helper's CAS fails
      // (ownership lost / no longer freezing), the run belongs to a fresh
      // owner — throw; nothing may be written.
      if (typeResolution?.outcome === 'conflicted') {
        // Test seam (PR4 re-review P1-2): fires inside the final CAS
        // immediately before the owner-guarded conflict terminal write so
        // tests can deterministically simulate a sibling reclaim between
        // conflict detection and the helper.
        hooks?.beforeConflictTerminal?.();
        const conflicted = failFrozenCohortRunForConflict(
          run.id,
          workerId,
          // PR13 (issue #30, DECISION-D): the conflict reason renders the
          // configured LABELS beside the deterministic ids in its distinct/
          // reviewed SUMMARIES — resolved from the ordinal-0 member's FROZEN
          // snapshot `productTypes` (all members froze under the same config
          // authority; unknown ids render id-only; member detail lines keep
          // the raw ids).
          buildCohortProductTypeConflictReason(
            typeResolution,
            frozenMembers[0]?.snapshot.productTypes ?? [],
          ),
        );
        if (!conflicted) {
          throw new CohortFreezeOwnershipError(
            `Freeze CAS lost ownership of run ${run.id} before the conflict terminal write (not freezing / claimed by ${workerId}).`,
          );
        }
      } else if (!transitionCohortRunToRunning(run.id, workerId)) {
        throw new CohortFreezeOwnershipError(`Freeze CAS could not transition run ${run.id} to running (ownership lost).`);
      }

      const finalized = getCohortRunById(run.id);
      if (!finalized) {
        throw new CohortFreezeOwnershipError(`Freeze CAS run ${run.id} disappeared after transition.`);
      }
      return finalized;
    })();
  };

  try {
    return finalize();
  } catch (err) {
    if (err instanceof CohortFreezeCasError) {
      // PR4 review fix (BLOCKER): the supersede is OWNER/observed-state
      // guarded. Between the failed final CAS (which rolled back its
      // transaction) and this supersede attempt, another worker can reclaim
      // the run — an unconditional supersede would kill the fresh owner's run
      // and child. Reload the row and supersede ONLY while it is STILL
      // claimed by THIS worker and still `freezing`, CAS'd on the observed
      // {claimed_by, lease_expires_at, status}. The observed values are read
      // FRESH (never the claim-time snapshot): the freeze's periodic
      // heartbeats renew lease_expires_at, and the CAS must match the row as
      // it exists now. A failed supersede, or a run already owned elsewhere
      // / not freezing anymore, is ownership loss: no further mutation — the
      // run survives with its new owner and the CAS error is surfaced.
      hooks?.beforeCasSupersede?.();
      const reason = `Freeze CAS drift: ${err.message}`;
      const current = getCohortRunById(run.id);
      if (current !== null && current.status === 'freezing' && current.claimedBy === workerId) {
        const superseded = supersedeCohortRunIfUnchanged(
          run.id,
          { claimedBy: current.claimedBy, leaseExpiresAt: current.leaseExpiresAt, status: current.status },
          reason,
        );
        if (superseded) {
          const supersededRow = getCohortRunById(run.id);
          if (supersededRow) return supersededRow;
        }
      }
      console.warn(
        `[CohortCurator] Freeze CAS supersede skipped for run ${run.id}: ownership changed after the failed CAS (no mutation — the run survives with its new owner).`,
      );
      throw err;
    }
    throw err;
  }
}
