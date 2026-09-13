/**
 * Curation Orchestrator — e04s01 audit (ADR 0004)
 *
 * Stage index (StageDefinition contract in src/classification/types.ts):
 * | # | Stage File                          | Stage Name                      | Requires                              | Produces                                   |
 * |---|-------------------------------------|-----------------------------------|---------------------------------------|--------------------------------------------|
 * | 1 | evidence-extraction.ts              | evidence_extraction               | —                                     | ClassificationEvidence (spreadsheet/official/distributor/visual + brand) |
 * | 2 | name-consolidation.ts               | name_consolidation                | evidence_extraction                   | metadata curatedTitle/titleSource (no proposals) |
 * | 3 | primary-product-type.ts             | primary_product_type_proposal     | evidence_extraction                   | primary_product_type proposal or reviewable_abstention |
 * | 4 | attribute-applicability.ts          | attribute_applicability           | primary_product_type_proposal         | metadata applicability[] (applicable/not_applicable/unknown) |
 * | 5 | attribute-proposals.ts              | product_attribute_proposals       | attribute_applicability               | field_assignment proposals or abstention (e04s01: no silent empty) |
 * | 6 | category-page-proposals.ts          | category_page_proposals           | evidence_extraction, primary_product_type_proposal | category_page proposals (gate: reviewed type + verified Pages) |
 * | 7 | draft-projection.ts                 | product_draft_projection          | name_consolidation, category_page_proposals, product_attribute_proposals | metadata projection {fieldAssignments/pageAssignments/title} |
 *
 * Frozen vs live discipline (src/classification/runtime-snapshot.ts):
 * - Legacy per-SKU: buildRuntimeSnapshot + persistRuntimeSnapshot + run linked to snapshotHash (live config path).
 * - Cohort (prepared member input): reuse frozen snapshot/member run + frozenBatchItems + settled member title/Page inputs; never re-read live DB for evidence/siblings — frozen-means-frozen (PR3/PR6/PR7).
 *
 * story: e04s01
 */
import { getPageDisplayName, getPageIdentityId } from '../shared/proposal-display';
import { convertToLbs } from '../shared/weight-converter';
import { captureVerifiedPageSnapshot, toPageSnapshotState } from '../classification/page-snapshot';
import { assertClassificationReady } from '../classification/readiness';
import { coordinateCohortItemsOnce, deterministicTitleWithVariants, itemVariantSources } from './cohort-name-coordinator';
import { listItemsByBatch, findExtractionDataJsonRowById } from '../db/repositories/onboarding-item-repo';
import { getDb } from '../db/connection';
import { loadRuntimeConfigAuthority, createRuntimeActivationContext } from '../classification/config-loader';
import { createConfigSnapshot, syncConfigToCache, getPersistedConfigSnapshotId, upsertConfigSnapshot } from '../db/repositories/classification-config-repo';
import { buildRuntimeSnapshot, persistRuntimeSnapshot } from '../classification/runtime-snapshot';
import type { RuntimeClassificationSnapshot } from '../classification/runtime-snapshot';
import {
  createRun,
  completeRun,
  getEvidenceByRun,
  getProposalsByRun,
  getStageResults,
} from '../db/repositories/classification-run-repo';
import { runPipeline } from '../classification/pipeline-runner';
import {
  evidenceExtractionStage,
  nameConsolidationStage,
  primaryProductTypeStage,
  attributeApplicabilityStage,
  productAttributeProposalsStage,
  categoryPageProposalsStage,
  productDraftProjectionStage,
} from '../classification';
import { valueGapAbstainStage } from '../classification/stages/value-gap-abstain';
import { getUniversalTierFlags } from '../classification/flags';
import { modelPolicyViewFromConfig } from './model-policy-snapshot';
import { redactTransportText, type ModelPolicyView } from '../classification/model-policy-gateway';
import { selectPrimaryProductTypeProposal } from '../classification/proposal-selection';
import { determineProductGroup } from './product-line-grouper';
import { listDistinctProductPageNames } from '../db/repositories/page-repo';
import { packagingOcrStage } from '../classification/stages/packaging-ocr-stage';
import { getOcrStageFlags } from '../classification/ocr-stage-flags';
import type { ProductLineItemSnapshot, StageDefinition, PipelineRunResult, ClassificationStageName, CoordinatedPageMemberValue } from '../classification/types';
import type { OnboardingItem, CurationData, ExtractionData } from '../shared/schemas/onboarding';
import type { ModelPolicyConfigV2 } from '../shared/schemas/classification';
import type {
  ExecutionEvidenceProjectionMemberV2,
} from '../shared/schemas/cohorts';
import type { ClassificationRunRow } from '../db/repositories/classification-run-repo';
import type { PreparedProductLineGroup } from './cohort-curation/frozen-evidence';

// ─── PR8 C3 — synthesis ordering guard (DECISION-C) ──────────────────────────

/**
 * The required stage set every active-cohort member pipeline must complete
 * before post-pipeline synthesis (description / search-keyword synthesis)
 * may run. Ordering guarantee (PR8 DECISION-C): synthesis is STRICTLY after
 * every pipeline stage, and in cohort mode it consumes ONLY frozen member-run
 * inputs — never live config, live Pages, current siblings, mutable
 * onboarding extraction, or current Product Type data.
 */
export const COHORT_SYNTHESIS_REQUIRED_STAGES: ClassificationStageName[] = [
  'evidence_extraction',
  'name_consolidation',
  'primary_product_type_proposal',
  'attribute_applicability',
  'product_attribute_proposals',
  'category_page_proposals',
  'product_draft_projection',
];

/**
 * PR8 C3 (DECISION-C): fail-closed synthesis ordering assertion — runs after
 * the pipeline completes and BEFORE `synthesizeSearchKeywords` /
 * `curatedDescription` execute. A failed stage already fails the member (the
 * pipeline throws); this guard makes the ordering contract explicit and fails
 * closed when a required stage SILENTLY produced no terminal output (neither
 * a `stageOutputs` entry for a succeeded stage nor a `reviewable_abstention`
 * proposal for an abstained stage) — a member must never be synthesized into
 * a partial draft from missing stage outputs.
 *
 * PR8 review R1 (identity): the error carries BOTH the parent/member run
 * identity (`runId`) and the member identity (`sku`).
 */
export function assertCohortSynthesisOrdering(
  result: PipelineRunResult,
  identity: { runId: string; sku: string },
): void {
  const abstainedStages = new Set(
    result.proposals
      .filter(p => p.proposalType === 'reviewable_abstention')
      .map(p => p.targetId as string),
  );
  for (const stageName of COHORT_SYNTHESIS_REQUIRED_STAGES) {
    if (result.stageOutputs[stageName] !== undefined) continue;
    if (abstainedStages.has(stageName)) continue;
    throw new Error(
      `Member ${identity.sku} (run ${identity.runId}) cohort synthesis ordering guard (PR8 DECISION-C): required stage ` +
        `"${stageName}" produced no terminal output before description/search-keyword synthesis; failing closed — ` +
        'no partial draft is synthesized.',
    );
  }
}

// ─── Page Assignment Validation ───────────────────────────────────────────────
// Species-guard moved to pure module so vitest (no bun:sqlite) can import it.
import { validatePageAssignmentsBySpecies, validatePageAssignmentsWithProvenance } from '../classification/species-guard';
import { validateCategoryPageAssignment } from '../classification/category-page-correctness';
// Re-export for tests that import from curator (back-compat)
export { validatePageAssignmentsWithProvenance, validatePageAssignmentsBySpecies };

/**
 * Compose the curation pipeline stage list — the SINGLE composition point
 * driven by BOTH the legacy per-item worker path (job-queue.processCuration)
 * AND prepared-cohort member execution (processCohort →
 * curateItemWithPipeline), so consumer wiring is identical for cohort and
 * non-cohort runs.
 *
 * P2-T6 (packaging-OCR overhaul, ordered consumer migration): the
 * `packaging_ocr` stage joins the executed list ONLY behind the single master
 * flag (`BAYSTATE_CMS_PACKAGING_OCR_STAGE_ENABLED`; PI kill-switch dominance
 * resolved inside the flags). Flag OFF (default) composes exactly today's
 * seven-stage list byte-identically. When included, the stage runs FIRST
 * (evidence_extraction declares `requires: ['packaging_ocr']`, honored by
 * `resolveStageOrder` only while the stage is present) and its fresh output
 * suppresses evidence_extraction's inline OCR via
 * `getAuthoritativePackagingOcrStageOutput`. Dual-run comparison happens
 * INSIDE the stage (`packagingOcrDualRunCompare`); shadow-only inclusion is
 * additive only (live OCR authority keys untouched).
 */
export function composeCurationPipelineStages(): StageDefinition[] {
  return [
    ...(getOcrStageFlags().packagingOcrStageEnabled ? [packagingOcrStage] : []),
    evidenceExtractionStage,
    nameConsolidationStage,
    primaryProductTypeStage,
    attributeApplicabilityStage,
    productAttributeProposalsStage,
    // P3 value-production ladder (plan B.P3.3): the flag-gated residual-gap
    // stage joins ONLY while BAYSTATE_CMS_VALUE_GAP_LLM is on. Flag OFF
    // (default) composes exactly today's list byte-identically. It runs after
    // `product_attribute_proposals` (reads its output) and before page
    // assignment; it never touches promotion gates or stage ordering for the
    // legacy seven stages.
    ...(getUniversalTierFlags().valueGapLlmEnabled ? [valueGapAbstainStage] : []),
    categoryPageProposalsStage,
    productDraftProjectionStage,
  ];
}

// ─── Prepared-member narrow entry (Slice 5) ─────────────────────────────────
/**
 * Narrow prepared-member input (plan §2.3): everything the member pipeline
 * needs, with cohort input construction already done BEFORE this seam by
 * `cohort-curation/members.ts` — a constructed frozen item, persisted child
 * identity, the immutable runtime snapshot, effective/execution type,
 * actually-used frozen sibling context, settled MEMBER title/Page inputs,
 * and the ownership assertion. It never recaptures authority and never
 * accepts caller-built whole-cohort output maps as proof of correctness
 * (the one-member Page map below is the member's own settled input, not a
 * cohort set — the unchanged materializer reads only its own SKU's entry).
 */
export interface CuratePreparedMemberInput {
  workspacePath: string;
  workspaceId: string;
  /** Ticket #124: operator gap-correction overlay (null = no open corrected gap). */
  correctionOverlay?: GapCorrectionOverlay | null;
  /** Live pipeline-state identity (id/upc/stage); semantic fields unused. */
  item: OnboardingItem;
  /** Executed member, constructed via `buildFrozenItem` before the seam. */
  frozenItem: OnboardingItem;
  /** Persisted child identity (ensured by the member executor). */
  childRun: ClassificationRunRow;
  /** Immutable member runtime snapshot (deep-frozen before the seam). */
  runtimeSnapshot: RuntimeClassificationSnapshot;
  modelPolicyView: ModelPolicyView | null;
  verifiedPageIds: string[];
  memberProjection: ExecutionEvidenceProjectionMemberV2;
  memberExtractionMethod: string | null;
  cohortExecutionType?: {
    id: string | null;
    confidence: number | null;
    outcome: 'coherent' | 'coherent_with_abstentions' | 'conflicted' | 'abstained' | null;
  };
  effectiveType?: { id: string | null; source: 'reviewed' | 'execution' | 'none' };
  productLineGroup: PreparedProductLineGroup | null;
  productLineItems?: ProductLineItemSnapshot[];
  /** Settled MEMBER title input (null = member-local naming path). */
  titleInput: { title: string; source: 'llm_cohort' | 'cohort_fallback' } | null;
  /** Settled MEMBER page input as a one-member map (absent = legacy gate path). */
  coordinatedPages?: Map<string, CoordinatedPageMemberValue>;
  pageCoordinationAbsent?: boolean;
  assertOwnershipHeld?: () => void;
}


/**
 * Ticket #124: operator gap-correction overlay consumed by curation.
 * Values apply ONLY to still-blank merchandising fields (title /
 * description) with explicit operator attribution — never into source
 * payloads, never over pipeline-produced values, never identity/variant
 * fields. Both worker modes thread the same input: legacy loads the open
 * gap's recorded envelope; cohort freezes it into the member projection.
 */
export interface GapCorrectionOverlay {
  values: Record<string, string>;
  correctionHash: string;
  actor: string;
  revision: number;
}

/**
 * Ticket #124: operator gap-correction overlay application (pure).
 * Exported for focused unit tests; production threads it through
 * executeCurationPipeline in both worker modes.
 */
export function applyGapCorrectionOverlay(
  overlay: GapCorrectionOverlay | null | undefined,
  current: { title: string | null; description: string | null },
): { title: string | null; description: string | null; appliedFields: string[] } {
  if (!overlay) return { ...current, appliedFields: [] };
  const appliedFields: string[] = [];
  const next = { ...current };
  for (const field of ['title', 'description'] as const) {
    const value = overlay.values[field];
    if (
      (next[field] === null || next[field]?.trim().length === 0) &&
      typeof value === 'string' && value.trim().length > 0
    ) {
      next[field] = value.slice(0, 2000);
      appliedFields.push(field);
    }
  }
  return { ...next, appliedFields };
}

/**
 * Resolve distributor-copy inputs for one executed item (moved verbatim out
 * of the shared curation body in Slice 5; called by both the legacy preamble
 * and the shared body so the Amendment B V1/V2 authority reads live in one
 * place). `memberExtractionMethod` is the frozen projection's method in
 * prepared mode, null in legacy mode (live provenance decides there).
 */
/**
 * Ticket #123: hash-bound merchandising authority for strategy-collection
 * envelopes. A validated envelope (validated at finalization and
 * re-checked at materialization) authorizes its consolidated copy exactly
 * when the envelope hash equals the decision hash — legacy v1/unverified
 * distributor paths stay identity-only.
 */
export function isStrategyCollectionAuthorized(
  ext: Record<string, unknown>,
  decisionEvidenceHash: string | null,
): boolean {
  const hash = (ext as { strategyCollectionProvenance?: { strategyCollectionHash?: unknown } | null })
    .strategyCollectionProvenance?.strategyCollectionHash;
  return typeof hash === 'string' && hash.length > 0 && hash === decisionEvidenceHash;
}

function resolveDistributorCopyInputs(
  item: OnboardingItem,
  ext: ExtractionData & Record<string, unknown>,
  memberExtractionMethod: string | null,
): { distributorSource: boolean; verifiedV2Distributor: boolean } {
  // ADR 0014 / PI-6: distributor images are DISPLAY-ONLY (see body).
  // Milestone E: distributor-record extraction data is IDENTITY-ONLY.
  const distributorSource = item.sourceType === 'distributor_record';
  // Amendment B (M5b-2): VERIFIED v2 merchandising authority (see body).
  const liveDistributorProvenance = (ext as {
    distributorRecordProvenance?: { extractionMethod?: string | null; evidenceHash?: string | null } | null;
  } | null)?.distributorRecordProvenance ?? null;
  const decisionEvidenceHash = (item.sourcingDecision as { evidenceHash?: string | null } | null)?.evidenceHash ?? null;
  const verifiedV2Distributor =
    distributorSource &&
    (memberExtractionMethod === 'distributor_record_v2' ||
      (liveDistributorProvenance?.extractionMethod === 'distributor_record_v2' &&
        typeof liveDistributorProvenance.evidenceHash === 'string' &&
        liveDistributorProvenance.evidenceHash.length > 0 &&
        liveDistributorProvenance.evidenceHash === decisionEvidenceHash) ||
      // Ticket #123: a validated strategy-collection envelope carries the
      // same hash-bound authority for its consolidated merchandising copy
      // (distributor and/or official contributions with per-field
      // attribution). The materializer already rejects hash mismatches, so
      // equality with the decision hash is the authority check — legacy
      // v1/unverified distributor paths stay identity-only.
      isStrategyCollectionAuthorized(ext as Record<string, unknown>, decisionEvidenceHash));
  return { distributorSource, verifiedV2Distributor };
}
/**
 * Narrow prepared-member entry (plan §2.3), used only by `members.ts`.
 * Cohort input construction happened before this seam; this entry resolves
 * nothing live and recaptures no authority — it maps the narrow input onto
 * the single shared pipeline execution body below.
 */
export async function curatePreparedMember(input: CuratePreparedMemberInput): Promise<CurationData> {
  return executeCurationPipeline({
    item: input.frozenItem,
    correctionOverlay: input.correctionOverlay ?? null,
    workspacePath: input.workspacePath,
    workspaceId: input.workspaceId,
    run: input.childRun,
    runtimeSnapshot: input.runtimeSnapshot,
    configSnapshotRef: input.runtimeSnapshot.configSnapshotRef,
    runModelPolicyView: input.modelPolicyView,
    legacyPageSnapshot: null,
    memberExtractionMethod: input.memberExtractionMethod,
    prepared: {
      memberProjection: input.memberProjection,
      cohortExecutionType: input.cohortExecutionType,
      effectiveType: input.effectiveType,
      productLineGroup: input.productLineGroup,
      productLineItems: input.productLineItems,
      preComputedTitle: input.titleInput?.title,
      preComputedTitleSource: input.titleInput?.source,
      coordinatedPages: input.coordinatedPages,
      pageCoordinationAbsent: input.pageCoordinationAbsent,
      verifiedPageIds: input.verifiedPageIds,
      assertOwnershipHeld: input.assertOwnershipHeld,
    },
  });
}

/**
 * Resolved prepared values consumed by the single shared pipeline execution
 * body. Built by `curatePreparedMember` (production) or the transitional
 * adapter (pre-Slice-6 tests) — never by spreading live semantic state.
 */
interface ResolvedPreparedInputs {
  memberProjection: ExecutionEvidenceProjectionMemberV2;
  cohortExecutionType: CuratePreparedMemberInput['cohortExecutionType'];
  effectiveType: CuratePreparedMemberInput['effectiveType'];
  productLineGroup: PreparedProductLineGroup | null;
  productLineItems?: ProductLineItemSnapshot[];
  preComputedTitle?: string;
  preComputedTitleSource?: 'llm_cohort' | 'cohort_fallback';
  coordinatedPages?: Map<string, CoordinatedPageMemberValue>;
  pageCoordinationAbsent?: boolean;
  verifiedPageIds: string[];
  assertOwnershipHeld?: () => void;
}

/**
 * Runs the modular classification pipeline for a curated item.
 * Uses the Classification Configuration from store/classification/
 * to produce structured proposals, evidence, and history records.
 *
 * Does NOT call legacy `curateItem()` — instead runs the full modular
 * pipeline including the name_consolidation stage for title synthesis.
 *
 * Falls back to a minimal compatibility object if no classification
 * config exists or the pipeline throws, so curation never blocks
 * the onboarding worker.
 */
export async function curateItemWithPipeline(
  item: OnboardingItem,
  workspacePath: string,
  workspaceId: string,
  correctionOverlay?: GapCorrectionOverlay | null,
): Promise<CurationData> {
  const ext = (item.extractionData ?? {}) as ExtractionData & Record<string, unknown>;

  // ADR 0014 / PI-6: distributor images are DISPLAY-ONLY. The non-cohort
  // distributor image backfill (previously copied identityJson.images into
  // primaryImage/additionalImages/images) is REMOVED fail-closed — images
  // may not enter extraction/classification/draft/promotion payloads until
  // a rights-and-identity verification pass is separately approved.

  // Milestone E: distributor-record extraction data is IDENTITY-ONLY. Copy
  // fields (description, search keywords, custom fields) never feed
  // classification inputs for distributor-source items — even if a malformed
  // payload carried them.
  // Legacy path: live provenance decides (memberExtractionMethod is null —
  // see `resolveDistributorCopyInputs`; the prepared path resolves its own
  // frozen method inside `curatePreparedMember`).
  const memberExtractionMethod: string | null = null;
  const { distributorSource, verifiedV2Distributor } = resolveDistributorCopyInputs(item, ext, memberExtractionMethod);

  let configSnapshotRef: {
    id: string;
    hash: string;
    sourceCommit: string | null;
    createdAt: string;
  };
  let runtimeSnapshot: RuntimeClassificationSnapshot;
  let runtimeSnapId: string;
  let runtimeSnapHash: string;
  let runModelPolicyView: ModelPolicyView | null;
  // Legacy-only verified-Page capture result (this entry is legacy-only;
  // the prepared path resolves its verified Page set before the seam).
  let legacyPageSnapshot: { pageImportId: string | null; verifiedPageIds: string[] } | null;

  {
    // ── Legacy per-SKU mode (byte-identical to today) ─────────────────────
    // Load the authoritative runtime config (ACTIVE v2 bundle when present,
    // transitional v1 otherwise). The modular pipeline works even without
    // full product types/attributes — name_consolidation always runs.
    const activationContext = createRuntimeActivationContext(workspacePath, workspaceId);
    const authority = loadRuntimeConfigAuthority(workspacePath, activationContext);
    // Capture the verified Page catalog ONCE, coherently (validates import/row
    // correspondence and throws on drift) BEFORE the readiness gate so the gate
    // is bound to the exact snapshot the run will freeze — an enabled Page
    // target can never start with pages.state='no_verified_page_catalog'.
    const pageSnapshot = captureVerifiedPageSnapshot(workspaceId);
    // Run-start readiness gate (issue #17 L): the ACTIVE v2 config must be
    // ready before any snapshot/run/model side effect. Not-ready throws
    // ClassificationNotReadyError, which the onboarding worker records as a
    // curation-stage failure with the stable reason (no transient retry).
    assertClassificationReady(authority, {
      catalogFields: activationContext.catalogFields,
      verifyCatalogEvidence: activationContext.verifyCatalogEvidence,
      verifiedPageIds: pageSnapshot.pageImportId ? pageSnapshot.verifiedPageIds : [],
    });
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
        createdAt: new Date().toISOString(),
      };
      focusedFileHashes = bundle.manifest.fileVersions;
      catalogEvidenceHash = bundle.manifest.catalogEvidenceHash;
      // The derived cache was written transactionally at activation.
    } else {
      try {
        syncConfigToCache(workspaceId, authority.config);
      } catch (err: any) {
        console.warn(`[ProductCurator] Failed to sync config to cache: ${err.message}`);
      }
      const { id: snapshotId, hash: snapshotHash } = createConfigSnapshot(workspaceId, authority.config);
      configSnapshotRef = {
        id: snapshotId,
        hash: snapshotHash,
        sourceCommit: null,
        createdAt: new Date().toISOString(),
      };
      focusedFileHashes = authority.config.manifest.fileVersions ?? {};
      catalogEvidenceHash = null;
    }

    // Build + freeze + persist ONE immutable runtime snapshot before run
    // creation so every stage reads the same frozen config, options, and facts.
    // The verified Page catalog (captured above, before readiness) is frozen in.
    runtimeSnapshot = buildRuntimeSnapshot({
      workspaceId,
      workspacePath,
      productSku: item.upc,
      authority,
      configSnapshotRef,
      focusedFileHashes,
      catalogEvidenceHash,
      sourceProductHash: '',
      // Amendment B (M5b-2): a VERIFIED v2 distributor materialization may
      // contribute its materialized description to keyword synthesis; v1 /
      // unverified / tampered distributor copy never does (identity-only).
      searchKeywords:
        distributorSource && !verifiedV2Distributor
          ? null
          : ext.searchKeywords ? String(ext.searchKeywords) : null,
      productPageNames: [],
      pages: toPageSnapshotState(pageSnapshot),
      pageImportId: pageSnapshot.pageImportId,
      pageImportHash: pageSnapshot.pageImportHash,
    });
    const persisted = persistRuntimeSnapshot(runtimeSnapshot);
    runtimeSnapId = persisted.id;
    runtimeSnapHash = persisted.hash;

    // Frozen model-policy view for every protected helper invocation in this
    // curation run (issue #17 pass 1b). V2 active bundles carry locality
    // attestation; v1/absent policies produce an explicit disabled view so
    // protected calls use deterministic fallbacks and never legacy routing.
    runModelPolicyView =
      authority.kind === 'v2' && runtimeSnapshot.modelPolicy
        ? modelPolicyViewFromConfig(
            runtimeSnapshot.modelPolicy as unknown as ModelPolicyConfigV2,
            runtimeSnapshot.snapshotHash,
          )
        : null;
    legacyPageSnapshot = {
      pageImportId: pageSnapshot.pageImportId,
      verifiedPageIds: pageSnapshot.verifiedPageIds,
    };
  }

  let run: ClassificationRunRow;
  {
    // Fail any existing running classification runs for this onboarding item to ensure
    // we do not violate the UNIQUE constraint from a stale run.
    if (item.id) {
      try {
        getDb().run(
          `UPDATE classification_runs
           SET status = 'failed', completed_at = ?, error_message = 'Superseded by new run'
           WHERE onboarding_item_id = ? AND status = 'running'`,
          [new Date().toISOString(), item.id]
        );
      } catch (err: any) {
        console.warn(`[ProductCurator] Failed to clean up existing running runs: ${err.message}`);
      }
    }

    // Create a classification run bound to the immutable runtime snapshot.
    // The onboarding source hash is null (no product source identity), matching
    // the snapshot's normalized representation so reviewed facts carry forward.
    run = createRun(workspaceId, item.upc, runtimeSnapId, runtimeSnapHash, {
      onboardingItemId: item.id,
      sourceKind: 'onboarding',
      sourceProductHash: runtimeSnapshot.sourceProductHash ?? null,
    });
  }

  return executeCurationPipeline({
    item,
    correctionOverlay: correctionOverlay ?? null,
    workspacePath,
    workspaceId,
    run,
    runtimeSnapshot,
    configSnapshotRef,
    runModelPolicyView,
    legacyPageSnapshot,
    memberExtractionMethod: null,
    prepared: null,
  });
}

/**
 * Single shared pipeline execution/assembly body (Slice 5): stage-context
 * construction, `runPipeline`, the synthesis-ordering guard, and
 * compatibility `CurationData` assembly. Used by BOTH the legacy per-item
 * path (above) and the narrow prepared entry (`curatePreparedMember`) —
 * never forked. Cohort input construction (frozen item, snapshot/child
 * refs, sibling/title/page selection) happens BEFORE this seam, in the
 * member executor or the transitional adapter.
 */
async function executeCurationPipeline(args: {
  item: OnboardingItem;
  /** Ticket #124: frozen operator correction overlay (both worker modes). */
  correctionOverlay?: GapCorrectionOverlay | null;
  workspacePath: string;
  workspaceId: string;
  run: ClassificationRunRow;
  runtimeSnapshot: RuntimeClassificationSnapshot;
  configSnapshotRef: { id: string; hash: string; sourceCommit: string | null; createdAt: string };
  runModelPolicyView: ModelPolicyView | null;
  legacyPageSnapshot: { pageImportId: string | null; verifiedPageIds: string[] } | null;
  memberExtractionMethod: string | null;
  prepared: ResolvedPreparedInputs | null;
}): Promise<CurationData> {
  const {
    item,
    workspacePath,
    workspaceId,
    run,
    runtimeSnapshot,
    configSnapshotRef,
    runModelPolicyView,
    legacyPageSnapshot,
  } = args;
  const cohortMode = args.prepared !== null;
  const prepared = args.prepared;
  const ext = (item.extractionData ?? {}) as ExtractionData & Record<string, unknown>;
  const { distributorSource, verifiedV2Distributor } = resolveDistributorCopyInputs(item, ext, args.memberExtractionMethod);

  if (process.env.BAYSTATE_CMS_DEBUG_WORKER) console.debug(`[ProductCurator] Starting classification pipeline for: "${item.name}"`);

  try {
    // ── Product-line grouping for family-aware curation ───────────────────
    // Determine sibling context before running the pipeline so
    // name_consolidation and page assignment can produce consistent
    // results across variants. Prefer context passed from the worker
    // (item.siblingGroup) to avoid re-querying. Fall back to internal
    // batch query when set directly (tests, API calls).
    //
    // PR3 hardening (Commit B / R2): prepared-cohort mode NEVER loads live
    // sibling data. The frozen product-line context (built by processCohort
    // via buildFrozenProductLineContext from the persisted cohort + full
    // execution-evidence projections) is the only sibling input — a
    // post-freeze mutation of a sibling's extraction_data_json/name/brand_hint
    // is never visible to title/page coordination.
    let productLineGroup: ReturnType<typeof determineProductGroup> | null = null;
    const attachedBatchItems = (item as OnboardingItem & { batchItems?: OnboardingItem[] }).batchItems;
    let batchItemsForCoordination: OnboardingItem[] = [];

    if (cohortMode) {
      // Prepared mode: the sibling group was constructed before the seam
      // (`buildPreparedProductLineGroup` — the SHOULD-FIX-2 gate on the
      // member's ACTUAL frozen group size lives there). Adapt it to the
      // legacy `determineProductGroup` shape the stages consume.
      const preparedGroup = prepared!.productLineGroup;
      if (preparedGroup) {
        productLineGroup = {
          groupId: preparedGroup.groupId,
          groupLabel: preparedGroup.groupLabel,
          normalizedBrand: '',
          normalizedName: '',
          siblingNames: preparedGroup.siblingNames,
          siblingWebTitles: preparedGroup.siblingWebTitles,
          siblingOcrTitles: preparedGroup.siblingOcrTitles,
          siblingSkus: preparedGroup.siblingSkus,
          sizeVariantCount: 0,
          flavorVariantCount: 0,
        };
      }
    } else {
      productLineGroup = (item as OnboardingItem & { siblingGroup?: ReturnType<typeof determineProductGroup> }).siblingGroup ?? null;
      if (!productLineGroup) {
        try {
          const db = getDb();
          const batchRows = db.query(
            `SELECT id, upc, name, brand_hint, source_type, extraction_data_json FROM onboarding_items WHERE batch_id = (SELECT batch_id FROM onboarding_items WHERE id = ?)`
          ).all(item.id) as Array<{
            id: string;
            upc: string;
            name: string;
            brand_hint: string | null;
            source_type: string | null;
            extraction_data_json: string | null;
          }>;

          const batchItems: OnboardingItem[] = batchRows.map(r => ({
            id: r.id,
            batchId: item.batchId,
            upc: r.upc,
            name: r.name,
            price: null,
            quantity: null,
            brandHint: r.brand_hint,
            departmentHint: null,
            sourceUrl: null,
            expectedName: null,
            // Milestone E: hydrate the REAL source type (distributor_record
            // items are identity-only for product-line grouping).
            sourceType: (r.source_type ?? 'official_page') as 'official_page' | 'distributor_record',
            acceptedEvidenceAttemptId: null,
            acceptedEvidenceAttemptIds: [],
            sourcingDecision: null,
            stage: 'prepare_listing' as const,
            stageStatus: 'pending' as const,
            isHeld: false,
            heldReason: null,
            rowNumber: 0,
            isDuplicate: false,
            existingSku: null,
            extractionData: r.extraction_data_json ? JSON.parse(r.extraction_data_json) : null,
            curationData: null,
            status: 'imported' as const,
            errorMessage: null,
            retryCount: 0,
            createdAt: '',
            updatedAt: '',
          }));

          productLineGroup = determineProductGroup(item, batchItems);
          if (productLineGroup) {
            console.log(`[ProductCurator] Product line group "${productLineGroup.groupId}": ${productLineGroup.siblingNames.length} siblings`);
          }
        } catch (err: any) {
          console.warn(`[ProductCurator] Product-line grouping failed (non-blocking): ${err.message}`);
        }
      } else {
        console.log(`[ProductCurator] Using sibling context from worker for ${item.upc}: group "${productLineGroup.groupId}"`);
      }

      batchItemsForCoordination = attachedBatchItems ?? [];
      if (productLineGroup && batchItemsForCoordination.length === 0) {
        try {
          batchItemsForCoordination = listItemsByBatch(item.batchId);
        } catch (error) {
          console.warn(`[ProductCurator] Failed to load batch snapshot for cohort coordination: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    const productLineItems: ProductLineItemSnapshot[] | undefined = cohortMode
      ? productLineGroup
        ? prepared!.productLineItems
        : undefined
      : productLineGroup
        ? productLineGroup.siblingSkus.map((sku, index) => {
            const sibling = batchItemsForCoordination.find(candidate => candidate.upc === sku);
            const extraction = sibling?.extractionData;
            const ocr = extraction?.packagingOcrData;
            return {
              sku,
              name: sibling?.expectedName ?? sibling?.name ?? productLineGroup!.siblingNames[index] ?? sku,
              webTitle: extraction?.title ?? productLineGroup!.siblingWebTitles[index] ?? null,
              brand: extraction?.brand ?? sibling?.brandHint ?? (productLineGroup!.normalizedBrand || null),
              description: extraction?.description ?? '',
              species: ocr?.species ?? [],
              flavor: ocr?.flavorVariety ?? null,
              lifeStage: ocr?.lifeStage ?? null,
              productForm: ocr?.productForm ?? null,
              healthConcern: ocr?.healthConcernFunction ?? [],
            };
          })
        : undefined;

    // Coordinate every title in a multi-item group through one cached,
    // all-or-nothing cohort decision. No sibling title is written here; each
    // item's own pipeline persists only its selected title metadata.
    let preComputedTitle: string | undefined;
    let preComputedTitleSource: 'llm_cohort' | 'cohort_fallback' | undefined;
    if ((productLineGroup?.siblingSkus.length ?? 0) >= 2) {
      if (cohortMode) {
        // Prepared mode: the settled MEMBER title input was selected before
        // the seam — prepared children NEVER call
        // `coordinateCohortItemsOnce()` and never invent a title (PR6/PR8
        // DECISION-B selection lives in `selectPreparedMemberTitleInput`).
        preComputedTitle = prepared!.preComputedTitle;
        preComputedTitleSource = prepared!.preComputedTitleSource;
      } else {
        try {
          const coordinated = await coordinateCohortItemsOnce(item.batchId, batchItemsForCoordination, runModelPolicyView);
          const selected = coordinated.get(item.upc);
          if (selected) {
            preComputedTitle = selected.title;
            preComputedTitleSource = selected.source;
          } else {
            // A grouped item must never fall through to an independent title LLM.
            preComputedTitle = deterministicTitleWithVariants(item.name, item.upc, item.brandHint, itemVariantSources(item));
            preComputedTitleSource = 'cohort_fallback';
          }
        } catch (err) {
          console.warn(
            `[ProductCurator] Cohort title coordination failed for ${item.upc}; using deterministic fallback: ${redactTransportText(err instanceof Error ? err.message : String(err))}`,
          );
          preComputedTitle = deterministicTitleWithVariants(item.name, item.upc, item.brandHint, itemVariantSources(item));
          preComputedTitleSource = 'cohort_fallback';
        }
      }
    }

    // Build the pipeline context
    const context: import('../classification/types').StageContext = {
      workspacePath,
      workspaceId,
      runId: run.id,
      configSnapshotRef,
      snapshot: runtimeSnapshot,
      // PR3 hardening C (1a): the member pipeline asserts the parent claim
      // immediately before EVERY post-await persistence transaction / terminal
      // update (evidence/proposals/links/stage completion). A rejected
      // assertion throws `HeartbeatLostError` and the persistence is skipped.
      // Absent in legacy mode — zero behavior change.
      assertHeld: prepared?.assertOwnershipHeld,
      // Prepared-cohort mode: the evidence stage consumes the frozen member
      // projection instead of reading onboarding_items (amendment 4). Current
      // freezes always write V2; historical V1 members normalize via the
      // shared adapter before reaching the pipeline (never passed raw).
      cohortFrozenEvidence: cohortMode
        ? prepared!.memberProjection
        : undefined,
      // PR4 C4b: cohort-level Execution Product Type resolved at freeze.
      // METADATA ONLY — no gate logic reads it in PR4 (review authority stays
      // on the member's own reviewed proposals). Present only in
      // prepared-cohort mode when the parent run carries an execution type;
      // flag OFF / abstained / conflicted / legacy runs leave it absent. The
      // cohort executor consumes it AFTER runPipeline to stamp dependency
      // metadata rows inside the member-projection atomic commit.
      cohortExecutionType: prepared?.cohortExecutionType,
      productLineContext: productLineGroup
        ? {
            groupId: productLineGroup.groupId,
            groupLabel: productLineGroup.groupLabel,
            siblingNames: productLineGroup.siblingNames,
            siblingWebTitles: productLineGroup.siblingWebTitles,
            siblingOcrTitles: productLineGroup.siblingOcrTitles,
            siblingSkus: productLineGroup.siblingSkus,
          }
        : undefined,
      productLineItems,
      preComputedTitle,
      preComputedTitleSource,
      // PR7 C4/C5: the durable parent-run page outputs (attached for every
      // member — groups AND singletons; empty map in DECISION-C config-level
      // absence). When present, the `category_page_proposals` stage skips the
      // reviewed-Type gate and both LLM paths and MATERIALIZES the stored
      // result with ZERO Page LLM calls.
      coordinatedPages: prepared?.coordinatedPages,
      // PR7 review R2 (F3.3): expected-empty marker — the child page stage
      // abstains with the clean legacy reason instead of warning about a
      // missing parent page output.
      pageCoordinationAbsent: prepared?.pageCoordinationAbsent,
    };

    // Initial evidence starts empty — evidence_extraction stage handles
    // reading the onboarding item's extraction_data_json from the DB
    // and producing spreadsheet, web, and visual evidence entries.

    // Run the full modular pipeline including name_consolidation. The
    // packaging_ocr stage joins the list ONLY when the master flag is ON —
    // see composeCurationPipelineStages (P2-T6 ordered consumer migration).
    const stages: StageDefinition[] = composeCurationPipelineStages();

    const result = await runPipeline(stages, context, {
      sku: item.upc,
      onboardingItemId: item.id,
      evidence: [],
      acceptedProposals: [],
      allProposals: [],
    });

    // PR8 C3 (DECISION-C): description/search-keyword synthesis is strictly
    // post-pipeline. In active cohort mode the pipeline must have produced a
    // terminal output for every required stage BEFORE synthesis runs (a
    // silently-no-output stage fails the member closed — never a partial
    // draft). Legacy mode keeps the historical post-pipeline order.
    if (cohortMode) {
      assertCohortSynthesisOrdering(result, { runId: run.id, sku: item.upc ?? item.id });
    }

    // Determine final status
    const hasAbstentions = result.proposals.some(p => p.proposalType === 'reviewable_abstention');
    const finalStatus = hasAbstentions ? 'completed_with_abstentions' : 'completed';
    // PR3 hardening (Commit B / R3): prepared-cohort mode leaves the child run
    // RUNNING — the terminal child write happens atomically with the
    // member-projection commit in processCohort (curation_data_json + item
    // stage + child terminal status in ONE transaction). A crash between
    // pipeline completion and that commit is therefore recovered: the recovery
    // skip rule only skips a member whose committed projection references a
    // terminal-success child. The child run id rides in
    // `curationData.classificationRunId`. Legacy (non-cohort) mode completes
    // the child exactly as today.
    if (!cohortMode) {
      // Ownership-guarded terminal child write (PR3 hardening A2): in
      // prepared-cohort mode the member's terminal write only proceeds while
      // the parent claim is still held — a sibling reclaim during the pipeline
      // leaves the child untouched (the new owner re-executes the member).
      completeRun(run.id, finalStatus);
    }

    // Collect persisted evidence and proposals
    const allEvidence = getEvidenceByRun(run.id);
    const allProposals = getProposalsByRun(run.id);
    const stageResults = getStageResults(run.id);

    // Build compatibility CurationData from pipeline outputs
    // Name consolidation metadata comes from the name_consolidation stage output
    const nameMeta = result.stageOutputs.name_consolidation?.metadata as Record<string, unknown> | undefined;
    const curatedTitle = nameMeta?.curatedTitle as string ?? ext.title ?? item.name;
    const titleSource = (nameMeta?.titleSource as string) ?? 'web';
    const packagingOcrTitle = (nameMeta?.packagingOcrTitle as string | null) ??
      ext.packagingOcrData?.productName ?? ext.packagingTitle ?? null;

    // ── Collect and deduplicate page proposals ────────────────────────────
    const pageProposals = allProposals
      .filter(p => p.proposalType === 'category_page')
      .sort((a, b) => {
        // Accepted first, then by confidence descending
        if (a.status === 'accepted' && b.status !== 'accepted') return -1;
        if (a.status !== 'accepted' && b.status === 'accepted') return 1;
        return b.confidence - a.confidence;
      });
    // Only identities verified in the FROZEN snapshot are suggestions. The
    // mutable page_index is never re-read after capture (issue #17 D1);
    // name-only/out-of-import proposals are review context and never surface.
    // In prepared-cohort mode the verified Page identity comes from the
    // freeze-persisted shared authorities (never a live re-capture).
    const verifiedPageIdSet = cohortMode
      ? new Set(prepared!.verifiedPageIds)
      : new Set(legacyPageSnapshot?.pageImportId ? legacyPageSnapshot.verifiedPageIds : []);
    const seenPageIds = new Set<string>();
    const rawSuggestedPages: string[] = [];
    for (const p of pageProposals) {
      const pageId = getPageIdentityId(p);
      const pageName = getPageDisplayName(p);
      if (!pageId || !verifiedPageIdSet.has(pageId)) continue;
      if (!pageName || seenPageIds.has(pageId)) continue;
      seenPageIds.add(pageId);
      rawSuggestedPages.push(pageName);
    }

    // ── Validate page assignments against species from VLM OCR evidence ───
    // e05s01: capture species-guard provenance for review UI (hard guard unchanged)
    const speciesGuardResult = validatePageAssignmentsWithProvenance(rawSuggestedPages, allEvidence);
    const validatedPages = speciesGuardResult.validated;
    const speciesGuardDropped = speciesGuardResult.dropped;

    // Suggested page names are already validated against the frozen verified
    // Page snapshot above — no post-run DB read is needed (ADR 0005).
    const suggestedPages = validatedPages;
    // Limit to top 5 to keep suggestions reasonable
    suggestedPages.splice(5);

    // ── Refresh extraction data from DB ────────────────────────────────
    // The evidence_extraction stage may have updated the DB with fresh VLM OCR
    // results during pipeline execution. Re-read the extraction data so that
    // curatedWeight and other downstream fields use the most recent OCR data.
    // Prepared-cohort mode SKIPS this refresh: frozen-means-frozen — the
    // executed member never re-reads live extraction data (the frozen-mode
    // evidence stage materializes from the projection, and OCR already ran
    // once at freeze).
    if (!cohortMode) {
      try {
        const freshRow = findExtractionDataJsonRowById(item.id);
        if (freshRow?.extraction_data_json) {
          const freshExt = JSON.parse(freshRow.extraction_data_json);
          if (freshExt && typeof freshExt === 'object') {
            // Merge fresh VLM/OCR data into the ext reference
            if (freshExt.packagingOcrData) {
              ext.packagingOcrData = freshExt.packagingOcrData;
            }
            if (freshExt.packagingTitle) {
              ext.packagingTitle = freshExt.packagingTitle;
            }
            if (freshExt.weight !== undefined) {
              ext.weight = freshExt.weight;
            }
          }
        }
      } catch (refreshErr: any) {
        const msg = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
        console.warn(
          `[ProductCurator] Post-run OCR/extraction refresh failed (non-blocking) for item ${item.id} (sku/upc ${item.upc}): ${msg}`,
        );
      }
    }

    // Suggested product type from the best available proposal
    const typeSelection = selectPrimaryProductTypeProposal({
      sku: item.upc,
      onboardingItemId: item.id,
      evidence: allEvidence,
      acceptedProposals: [],
      allProposals: allProposals,
    });
    const suggestedProductType = typeSelection.proposal?.targetId ?? null;

    // LEGACY fallback — active cohort mode skips this; kept for flag-OFF compatibility only.
    // Validated via category-page-correctness — unverified/incompatible pages abstain.
    // See Deslop H1: gate explicitly behind !cohortMode (== cohortCurationV2Enabled===false).
    if (!cohortMode && suggestedPages.length === 0 && (suggestedProductType || item.name)) {
      try {
        const text = `${suggestedProductType || ''} ${item.name}`.toLowerCase();
        const allStorePages = listDistinctProductPageNames();

        // Frozen verified catalog for validation (from the run's snapshot, not live DB names)
        const verifiedRecords = runtimeSnapshot.pages?.state === 'verified'
          ? runtimeSnapshot.pages.records
          : undefined;
        const catalogForValidation = (verifiedRecords ?? [])
          .filter(r => r.verified !== false)
          .map(r => ({ id: r.pageId, name: r.pageName, parentId: r.parentPageId ?? null }));
        const pageIdByName = new Map(catalogForValidation.map(r => [r.name.toLowerCase(), r.id] as const));
        const canPushPageName = (name: string): boolean => {
          if (!pageIdByName.has(name.toLowerCase())) return false;
          if (catalogForValidation.length === 0) return false;
          const pid = pageIdByName.get(name.toLowerCase())!;
          const result = validateCategoryPageAssignment({
            member: {
              onboardingItemId: item.id,
              frozenEvidenceHash: `fallback:${item.id}`,
              frozenEvidence: {
                title: item.name,
                description: item.extractionData?.description ?? null,
                productType: suggestedProductType,
                species: ext?.packagingOcrData?.species ?? [],
                form: ext?.packagingOcrData?.productForm ?? null,
              },
            },
            candidate: { primaryPageId: pid, secondaryPageIds: [], primaryPageName: name },
            verifiedPageCatalog: catalogForValidation,
            activePageImportHash: runtimeSnapshot.pageImportHash ?? 'unknown',
          });
          return result.valid && result.outcome === 'assigned';
        };

        if (text.includes('chew') || text.includes('dog treat')) {
          if (allStorePages.includes('Dog Treats Bones Bully Sticks & Natural Chews') && canPushPageName('Dog Treats Bones Bully Sticks & Natural Chews')) suggestedPages.push('Dog Treats Bones Bully Sticks & Natural Chews');
          if (allStorePages.includes('Dog Treats Shop All') && canPushPageName('Dog Treats Shop All')) suggestedPages.push('Dog Treats Shop All');
        } else if (text.includes('churu') || text.includes('cat food') || text.includes('entree') || text.includes('mousse') || text.includes('gravy')) {
          if (allStorePages.includes('Cat Food Wet') && canPushPageName('Cat Food Wet')) suggestedPages.push('Cat Food Wet');
          if (allStorePages.includes('Cat Food Shop All') && canPushPageName('Cat Food Shop All')) suggestedPages.push('Cat Food Shop All');
        }
        suggestedPages.splice(5);
      } catch {
        /* page-name suggestion fallback is best-effort */
      }
    }
    // Synthesize search keywords from richer pipeline data
    const attributeProposals = allProposals.filter(p => p.proposalType === 'field_assignment' && p.status === 'accepted');
    const attributeKeywords = attributeProposals
      .map(p => {
        const v = p.proposedValue;
        return typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : null;
      })
      .filter((v): v is string => !!v);
    const speciesLabels = ext.packagingOcrData?.species ?? [];

    // ── Distributor record: consolidate multi-provider copy ───────────────
    // This runs AFTER the classification pipeline intentionally.
    // During classification, raw per-provider evidence (from the
    // evidence_extraction stage and buildClassificationEvidenceFromAttempts)
    // is consumed by name_consolidation, product-type classification, and
    // page-assignment stages. Consolidating here creates the final
    // curatedDescription and source-attempt provenance for draft copy —
    // it does not feed back into classification.

    // Amendment B (M5b-2): a VERIFIED v2 distributor materialization sets
    // curatedDescription deterministically from the materialized description
    // with the source attempt IDs from the merchandising provenance. V1 /
    // unverified / tampered distributor copy stays null (ADR 0014: distributor
    // copy is not v1 merchandising authority). The model-backed
    // distributor-copy consolidator stays disabled — the deterministic
    // projection v2 merge is the only authority.
    const merchandisingProvenance = (ext as {
      merchandisingProvenance?: Record<string, Array<{ attemptId: string; providerId: string; values?: string[] }>>;
    }).merchandisingProvenance
      ?? (ext as {
        distributorRecordProvenance?: {
          merchandisingProvenance?: Record<string, Array<{ attemptId: string; providerId: string; values?: string[] }>>;
        } | null;
      }).distributorRecordProvenance?.merchandisingProvenance
      ?? {};
    const selectedDescription =
      verifiedV2Distributor && typeof ext.description === 'string' && ext.description.trim().length > 0
        ? ext.description
        : null;
    const curatedDescription: string | null = selectedDescription;
    const curatedDescriptionSourceAttemptIds: string[] =
      selectedDescription !== null
        ? Array.from(
            new Set(
              (merchandisingProvenance['description'] ?? [])
                .filter((e) => (e.values ?? []).includes(selectedDescription))
                .map((e) => e.attemptId),
            ),
          ).sort()
        : [];

    // Ticket #124: operator gap-correction overlay fills ONLY still-blank
    // merchandising fields, attributed as operator input (never source
    // evidence, never over pipeline values). Applied identically in both
    // worker modes — the overlay arrived frozen (legacy: recorded envelope;
    // cohort: member projection).
    const overlayApplied = applyGapCorrectionOverlay(args.correctionOverlay, {
      title: curatedTitle,
      description: curatedDescription,
    });
    const searchKeywords = synthesizeSearchKeywords({
      // Ticket #124 P2-7: synthesize from overlay-applied copy (identical
      // to pre-overlay values unless a correction filled a blank) so a
      // title/description-fixing correction reaches keywords too.
      title: overlayApplied.title ?? curatedTitle,
      brand: ext.brand ?? item.brandHint,
      // Amendment B (M5b-2): a verified v2 distributor materialization's
      // materialized description contributes to keyword synthesis; v1 /
      // unverified / tampered distributor copy never does. Operator
      // correction text on an unverified distributor item stays out as
      // well (fail closed: keywords never launder unverified copy).
      description: distributorSource && !verifiedV2Distributor ? null : overlayApplied.description,
      suggestedPages,
      suggestedProductType,
      species: speciesLabels,
      lifeStage: ext.packagingOcrData?.lifeStage,
      productForm: ext.packagingOcrData?.productForm,
      attributes: attributeKeywords,
    });

    return {
      curatedTitle: overlayApplied.title,
      searchKeywords,
      packagingOcrTitle,
      curatedWeight: convertToLbs(
        ext.packagingOcrData?.weight || ext.weight || extractWeightFromName(item.name) || null,
      ),
      titleSource: titleSource as 'web' | 'ocr' | 'llm' | 'manual' | 'llm_cohort' | 'cohort_fallback',
      curatedDescription: overlayApplied.description,
      curatedDescriptionSourceAttemptIds,
      // Ticket #124: operator-correction provenance (absent without an
      // applied overlay — legacy/cohort runs stay byte-identical).
      ...(overlayApplied.appliedFields.length > 0 && args.correctionOverlay
        ? {
          correctionProvenance: {
            correctionHash: args.correctionOverlay.correctionHash,
            revision: args.correctionOverlay.revision,
            actor: args.correctionOverlay.actor,
            fields: overlayApplied.appliedFields,
          },
        }
        : {}),
      suggestedPages,
      suggestedProductType,
      curatedAt: new Date().toISOString(),
      curationMethod: 'auto',
      classificationRunId: run.id,
      classificationConfigSnapshot: context.configSnapshotRef,
      classificationEvidence: allEvidence,
      classificationProposals: allProposals,
      classificationDecisions: [],
      classificationHistory: stageResults.map(sr => ({
        id: String(sr.id),
        runId: run.id,
        proposalId: null,
        decisionId: null,
        eventType: `stage_${sr.stage_name}`,
        eventJson: { status: sr.status, output: sr.output_json },
        createdAt: String(sr.started_at),
      })),
      // PR5 (DECISION-J): expose the member's effective Curation Product Type
      // (reviewed-first / cohort Execution Product Type fallback / none) on
      // the curation data — read-only observability in prepared-cohort mode
      // only. The prepared effective type is always present in cohort mode;
      // legacy (non-cohort) runs never carry the key (undefined keys are
      // dropped by JSON.stringify), keeping flag-OFF output byte-identical.
      effectiveProductType: cohortMode && prepared!.effectiveType
        ? { id: prepared!.effectiveType.id, source: prepared!.effectiveType.source }
        : undefined,
      // e05s01: review observability — additive, absent in legacy runs keeps byte-identical
      // story: e05s01
      attributeApplicability: (() => {
        const meta = result.stageOutputs.attribute_applicability?.metadata as { applicability?: Array<{ attributeId: string; state: string; reason?: string }> } | undefined;
        const arr = Array.isArray(meta?.applicability) ? meta!.applicability : [];
        return arr.map(entry => ({
          attributeId: String(entry.attributeId),
          state: (entry.state as 'applicable' | 'not_applicable' | 'unknown'),
          reason: entry.reason ? String(entry.reason) : undefined,
        }));
      })(),
      categoryPageGating: (() => {
        // Gate reasons are encoded as abstention proposals; check proposals for reviewable_abstention target category_page_proposals
        const catAbstention = result.proposals.find(p => p.proposalType === 'reviewable_abstention' && String(p.targetId) === 'category_page_proposals');
        const reasonRaw = (catAbstention?.proposedValue as { reason?: string } | null)?.reason ?? null;
        const needsReviewedType = reasonRaw ? reasonRaw.includes('No reviewed Primary Product Type') : false;
        const needsVerifiedPages = reasonRaw ? reasonRaw.includes('No verified store pages available') : false;
        return {
          needsReviewedType,
          needsVerifiedPages,
          verifiedPageCount: verifiedPageIdSet.size,
          reason: reasonRaw,
          verifiedPageIdSet: Array.from(verifiedPageIdSet),
          snapshotHash: runtimeSnapshot.snapshotHash ?? null,
        };
      })(),
      speciesGuardDropped,
      // story: e05s02 — taxonomy provenance per field (bundle/snapshot/verified identity), no invented IDs
      taxonomyProvenance: (() => {
        const bundleHash = runtimeSnapshot.configSnapshotRef?.hash ?? context.configSnapshotRef?.hash ?? null;
        const snapHash = runtimeSnapshot.snapshotHash ?? null;
        const fileVersions = runtimeSnapshot.focusedFileHashes ?? {};
        const verifiedIds = Array.from(verifiedPageIdSet);
        const effectiveTypeId = (cohortMode && prepared!.effectiveType?.id) || suggestedProductType;
        const profileEntry = effectiveTypeId
          ? runtimeSnapshot.attributeProfiles.find(p => p.productTypeId === effectiveTypeId) ?? null
          : runtimeSnapshot.attributeProfiles[0] ?? null;
        return {
          bundleHash,
          bundleVersion: bundleHash ? String(bundleHash).slice(0, 8) : null,
          snapshotHash: snapHash,
          manifestFileVersions: fileVersions,
          verifiedPageCount: verifiedPageIdSet.size,
          verifiedPageIdSet: verifiedIds,
          attributeProfileId: profileEntry ? (profileEntry as { id?: string }).id ?? null : null,
          classificationRunId: run.id,
        };
      })(),
    };
  } catch (err) {
    console.error(`[ProductCurator] Classification pipeline failed:`, redactTransportText(err instanceof Error ? err.message : String(err)));
    // Ownership-guarded terminal child write (PR3 hardening A2): a pipeline
    // error that coincides with a lost claim never gets a terminal child
    // write from the stale owner — `assertOwnershipHeld` throws
    // `HeartbeatLostError` first and the child stays untouched.
    prepared?.assertOwnershipHeld?.();
    completeRun(run.id, 'failed', redactTransportText(err instanceof Error ? err.message : String(err)));
    throw err;
  }
}

/**
 * Extract a weight string from a product's spreadsheet import name.
 *
 * Handles common patterns like "6OZ", "16OZ", "48OZ", "23 OZ", "5LB", "2kg"
 * that appear embedded in distributor product names. Avoids false matches
 * on non-weight suffixes like "MD2CT" (2-count), "SM5CT" (5-count), "30PK"
 * (30-pack), or ordinals like "4TH".
 *
 * Returns the normalised weight string (e.g. "6 oz") or null.
 */
function extractWeightFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  const match = /(\d+(?:\.\d+)?)\s*(OZ|OZS?|LB|LBS?|OUNCE|OUNCES|GRAM|GRAMS|G|KG)\b/i.exec(name);
  if (!match) return null;
  // Normalise unit to lowercase
  return `${match[1]} ${match[2].toLowerCase()}`;
}

/**
 * Synthesize search keywords from curated product data for ShopSite SearchKeywords.
 * Combines title, brand, species/attributes, page names, and product type into
 * a concise keyword string (capped at 250 chars).
 */
function synthesizeSearchKeywords(options: {
  title: string;
  brand?: string | null;
  description?: string | null;
  suggestedPages?: string[];
  suggestedProductType?: string | null;
  species?: string[];
  lifeStage?: string | null;
  productForm?: string | null;
  attributes?: string[];
}): string {
  const parts: string[] = [];

  // 1. Title + brand
  if (options.title) parts.push(options.title);
  if (options.brand && !options.title.toLowerCase().includes(options.brand.toLowerCase())) {
    parts.push(options.brand);
  }

  // 2. Species + life stage + product form (from VLM OCR)
  if (options.species && options.species.length > 0) {
    const uniqueSpecies = [...new Set(options.species.map(s => s.toLowerCase()))];
    for (const s of uniqueSpecies) {
      if (!parts.some(p => p.toLowerCase().includes(s))) {
        parts.push(s.charAt(0).toUpperCase() + s.slice(1));
      }
    }
  }
  if (options.lifeStage && !parts.some(p => p.toLowerCase().includes(options.lifeStage!.toLowerCase()))) {
    parts.push(options.lifeStage);
  }
  if (options.productForm && !parts.some(p => p.toLowerCase().includes(options.productForm!.toLowerCase()))) {
    parts.push(options.productForm);
  }

  // 3. Attribute values from classification
  if (options.attributes && options.attributes.length > 0) {
    for (const attr of options.attributes) {
      if (attr && !parts.some(p => p.toLowerCase().includes(attr.toLowerCase()))) {
        parts.push(attr);
      }
    }
  }

  // 4. Suggested product type
  if (options.suggestedProductType && !parts.some(p => p.toLowerCase().includes(options.suggestedProductType!.toLowerCase()))) {
    parts.push(options.suggestedProductType);
  }

  // 5. Page / category names
  if (options.suggestedPages && options.suggestedPages.length > 0) {
    const pageKeywords = options.suggestedPages
      .filter(p => !parts.some(part => part.toLowerCase().includes(p.toLowerCase())))
      .slice(0, 3); // limit to top 3 pages to avoid noise
    parts.push(...pageKeywords);
  }

  // 6. Key phrases from description (extract noun phrases, limit to one)
  if (options.description) {
    const words = options.description.replace(/[<>[\]]/g, '').split(/\s+/).filter(w => w.length > 3);
    const uniqueWords = [...new Set(words)];
    const hasDescriptionContent = parts.some(p => {
      const pWords = p.toLowerCase().split(/\s+/);
      return pWords.some(w => uniqueWords.some(uw => uw.toLowerCase() === w));
    });
    if (!hasDescriptionContent && uniqueWords.length > 0) {
      // Add up to 3 distinctive keywords from the description not already in parts
      const allPartLower = parts.join(' ').toLowerCase();
      const fresh = uniqueWords.filter(w => !allPartLower.includes(w.toLowerCase())).slice(0, 3);
      parts.push(...fresh);
    }
  }

  // Deduplicate and join, capped at 250 chars so it fits ShopSite's practical limit
  const seen = new Set<string>();
  const deduped = parts.filter(p => {
    const key = p.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let result = deduped.join(', ');
  if (result.length > 250) {
    result = result.substring(0, 250).replace(/,\s*[^,]*$/, '');
  }

  return result;
}
