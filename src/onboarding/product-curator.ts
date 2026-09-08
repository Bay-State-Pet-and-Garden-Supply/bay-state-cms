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
 * - Cohort (preparedCohort): reuse frozen snapshot/member run + frozenBatchItems + coordinatedTitles/Pages; never re-read live DB for evidence/siblings — frozen-means-frozen (PR3/PR6/PR7).
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
import { buildRuntimeSnapshot, persistRuntimeSnapshot, getRuntimeSnapshotByHash, deepFreeze } from '../classification/runtime-snapshot';
import type { RuntimeClassificationSnapshot } from '../classification/runtime-snapshot';
import { ensureMemberRun } from '../db/repositories/classification-cohort-run-repo';
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
import type { ProductLineItemSnapshot, StageDefinition, PipelineRunResult, ClassificationStageName } from '../classification/types';
import type { OnboardingItem, CurationData, ExtractionData } from '../shared/schemas/onboarding';
import type { ClassificationEvidence } from '../shared/schemas/classification';
import type { ModelPolicyConfigV2 } from '../shared/schemas/classification';
import { buildFrozenItem } from './cohort-curator';
import type { PreparedCohortContext } from './cohort-curator';

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
  preparedCohort?: PreparedCohortContext,
): Promise<CurationData> {
  // Prepared-cohort mode (issue #30 PR3 M2, amendment 6): the member executes
  // against the FROZEN execution-evidence projection + freeze-persisted
  // runtime snapshot. The item's live `extractionData`/`sourceUrl` (which may
  // have mutated after the freeze) is overlaid with the frozen projection so
  // the executed member never reads post-freeze mutations. Absent the
  // prepared context, this function is byte-identical to today's behavior.
  const cohortMode = preparedCohort !== undefined;
  if (cohortMode) {
    // PR3 hardening (Commit B / R2): prepared mode CONSTRUCTS the executed
    // member FROM the frozen projection — identity from the live item, every
    // semantic field from the projection (authoritative null sourceUrl stays
    // null; NO live `...ext` spread).
    item = buildFrozenItem(preparedCohort!.memberProjection, item);
  }
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
  const distributorSource = item.sourceType === 'distributor_record';

  // Amendment B (M5b-2): VERIFIED v2 merchandising authority. Distributor
  // copy unlocks ONLY for a verified `distributor_record_v2` materialization:
  //  - live path: the payload's provenance declares distributor_record_v2 AND
  //    its evidence hash equals the item's persisted sourcing decision (a
  //    tampered/replaced payload never unlocks copy);
  //  - prepared-cohort path: the FROZEN member projection's extractionMethod
  //    is authoritative (validated at freeze) — live values are never
  //    consulted for the executed member.
  // V1 / unverified / tampered materializations keep the fail-closed
  // suppression below (identity-only).
  const liveDistributorProvenance = (ext as {
    distributorRecordProvenance?: { extractionMethod?: string | null; evidenceHash?: string | null } | null;
  } | null)?.distributorRecordProvenance ?? null;
  const memberExtractionMethod = cohortMode
    ? ((preparedCohort?.memberProjection as { extractionMethod?: string | null } | null)?.extractionMethod ?? null)
    : null;
  const decisionEvidenceHash = (item.sourcingDecision as { evidenceHash?: string | null } | null)?.evidenceHash ?? null;
  const verifiedV2Distributor =
    distributorSource &&
    (memberExtractionMethod === 'distributor_record_v2' ||
      (liveDistributorProvenance?.extractionMethod === 'distributor_record_v2' &&
        typeof liveDistributorProvenance.evidenceHash === 'string' &&
        liveDistributorProvenance.evidenceHash.length > 0 &&
        liveDistributorProvenance.evidenceHash === decisionEvidenceHash));

  if (process.env.BAYSTATE_CMS_DEBUG_WORKER) console.debug(`[ProductCurator] Starting classification pipeline for: "${item.name}"`);

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
  // Legacy-only verified-Page capture result (null in prepared-cohort mode).
  let legacyPageSnapshot: { pageImportId: string | null; verifiedPageIds: string[] } | null = null;

  if (cohortMode) {
    // ── Prepared-cohort mode (amendment 6) ─────────────────────────────────
    // SKIP authority capture, per-SKU snapshot build and stale-run cleanup:
    // the member runs against the freeze-persisted runtime snapshot (shared
    // authorities captured ONCE at freeze) and the freeze-created child run.
    const ctx = preparedCohort!;
    const loadedSnapshot = getRuntimeSnapshotByHash(workspaceId, ctx.memberSnapshotHash);
    if (!loadedSnapshot) {
      throw new Error(
        `Prepared-cohort mode: frozen member runtime snapshot ${ctx.memberSnapshotHash} not found; the freeze may not have persisted it.`,
      );
    }
    runtimeSnapshot = deepFreeze(loadedSnapshot);
    runtimeSnapId = ctx.memberSnapshotId;
    runtimeSnapHash = ctx.memberSnapshotHash;
    configSnapshotRef = runtimeSnapshot.configSnapshotRef;
    runModelPolicyView = ctx.sharedAuthorities.modelPolicyView;
  } else {
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

  let run: import('../db/repositories/classification-run-repo').ClassificationRunRow;
  if (cohortMode) {
    // ── Prepared-cohort mode ───────────────────────────────────────────────
    // Reuse the freeze-created child run (idempotent ensureMemberRun) and link
    // its config refs from the persisted member snapshot. No stale-run cleanup
    // and no new createRun — the child already exists and is running.
    const ctx = preparedCohort!;
    run = ensureMemberRun(ctx.parentRunId, item.id, workspaceId, item.upc, ctx.memberSnapshotId, ctx.memberSnapshotHash);
    if (run.configSnapshotId !== ctx.memberSnapshotId || run.configSnapshotHash !== ctx.memberSnapshotHash) {
      // Crash-recovery re-creation (or a prior partial freeze) may have left
      // stale refs — re-link from the freeze-persisted member snapshot.
      getDb().run(
        'UPDATE classification_runs SET config_snapshot_id = ?, config_snapshot_hash = ? WHERE id = ?',
        [ctx.memberSnapshotId, ctx.memberSnapshotHash, run.id],
      );
    }
  } else {
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
      const frozenCtx = preparedCohort!;
      // PR6 review fix (SHOULD-FIX 2): gate on the member's ACTUAL frozen
      // `groupByProductLine` group size (the exact grouping the parent title
      // op's coordinator uses) — never the all-cohort sibling count. A true
      // singleton (size 1) has no durable output row and keeps the unchanged
      // per-item `name_consolidation` path (no deterministic fallback, no
      // warning). Hand-built test contexts that omit `memberGroupSizes` fall
      // back to the all-cohort sibling count (uniform cohorts only).
      const memberGroupSize =
        frozenCtx.memberGroupSizes?.get(item.upc) ?? (frozenCtx.productLineContext?.siblingSkus.length ?? 0);
      if (frozenCtx.productLineContext && memberGroupSize >= 2) {
        productLineGroup = {
          groupId: frozenCtx.productLineContext.groupId,
          groupLabel: frozenCtx.productLineContext.groupLabel,
          normalizedBrand: '',
          normalizedName: '',
          siblingNames: frozenCtx.productLineContext.siblingNames,
          siblingWebTitles: frozenCtx.productLineContext.siblingWebTitles,
          siblingOcrTitles: frozenCtx.productLineContext.siblingOcrTitles,
          siblingSkus: frozenCtx.productLineContext.siblingSkus,
          sizeVariantCount: 0,
          flavorVariantCount: 0,
        };
        console.log(`[ProductCurator] Using frozen sibling context for ${item.upc}: group "${productLineGroup.groupId}"`);
      }
      batchItemsForCoordination = frozenCtx.frozenBatchItems ?? [];
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
            stage: 'curation' as const,
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
        ? preparedCohort!.productLineItems
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
        // PR6 (issue #30): prepared children NEVER call
        // `coordinateCohortItemsOnce()`. The parent title op
        // (`ensureCohortTitlesCoordinated`) already persisted every group
        // member's title into `classification_cohort_outputs` BEFORE the
        // member loop; read it here. The coordinator + `cohortCache` are
        // never consulted in active cohort mode.
        //
        // PR8 C2 (DECISION-B): a MISSING stored title output for a multi-item
        // group member is a parent-op contract violation — the member FAILS
        // with a deterministic error (no invented title). The DECISION-R
        // warn+fallback is now parent-op-only in active cohort mode: a
        // durable row with source 'cohort_fallback' is legitimate (the parent
        // op wrote it), but a MISSING row (no durable output at all) can never
        // be repaired by the child. The fail-closed throw is keyed on the
        // FROZEN per-member group sizes (`memberGroupSizes` present AND this
        // member's group >= 2 — the exact grouping the parent title op uses,
        // attached by processCohort). Hand-built test contexts that omit
        // `memberGroupSizes` (and legacy/shadow, which never reach this
        // branch) keep the PR6 DECISION-R warn+fallback byte-identical. The
        // title values on this map are already parsed through
        // `CohortTitleOutputSchema` by the parent op (the map is built from
        // parsed rows), so the child-side corrupt-title guard is STRUCTURAL —
        // documented here, not duplicated.
        // PR8 review R1 (identity): carry BOTH the member identity AND the
        // parent run identity in the deterministic fail-closed error.
        const selected = preparedCohort!.coordinatedTitles?.get(item.upc);
        if (selected) {
          // PR8 review R1 (BLOCKER 2d): a member-side defensive throw for an
          // EMPTY title from the durable map. The parent op's writers can
          // never emit an empty title and the reuse path fails corrupt/empty
          // rows closed before the member loop, so this is reachable only for
          // hand-built contexts (or a future writer bug) — the member FAILS
          // closed instead of threading an empty title into
          // name_consolidation (which would otherwise fall through to per-item
          // synthesis and invent a title).
          if (typeof selected.title !== 'string' || selected.title.trim().length === 0) {
            throw new Error(
              `Member ${item.upc ?? item.id} (run ${run.id}) has an EMPTY persisted cohort title output in active cohort mode ` +
                '(PR8 review R1): failing closed — no title may be invented from a corrupt parent output.',
            );
          }
          preComputedTitle = selected.title;
          preComputedTitleSource = selected.source;
        } else {
          const memberGroupSize =
            preparedCohort!.memberGroupSizes?.get(item.upc) ??
            (preparedCohort!.productLineContext?.siblingSkus.length ?? 0);
          if (preparedCohort!.memberGroupSizes !== undefined && memberGroupSize >= 2) {
            throw new Error(
              `Member ${item.upc ?? item.id} (run ${run.id}) is missing a persisted cohort title output in active cohort mode ` +
                '(PR8 DECISION-B): the parent-op contract was violated and no title may be invented; the member fails closed.',
            );
          }
          console.warn(
            `[ProductCurator] Member ${item.upc} missing a persisted cohort title output — using deterministic fallback.`,
          );
          preComputedTitle = deterministicTitleWithVariants(item.name, item.upc, item.brandHint, itemVariantSources(item));
          preComputedTitleSource = 'cohort_fallback';
        }
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
      assertHeld: preparedCohort?.assertOwnershipHeld,
      // Prepared-cohort mode: the evidence stage consumes the frozen member
      // projection instead of reading onboarding_items (amendment 4). Current
      // freezes always write V2; historical V1 members normalize via the
      // shared adapter before reaching the pipeline (never passed raw).
      cohortFrozenEvidence: cohortMode
        ? (preparedCohort!.memberProjection as import('../shared/schemas/cohorts').ExecutionEvidenceProjectionMemberV2)
        : undefined,
      // PR4 C4b: cohort-level Execution Product Type resolved at freeze.
      // METADATA ONLY — no gate logic reads it in PR4 (review authority stays
      // on the member's own reviewed proposals). Present only in
      // prepared-cohort mode when the parent run carries an execution type;
      // flag OFF / abstained / conflicted / legacy runs leave it absent. The
      // cohort executor consumes it AFTER runPipeline to stamp dependency
      // metadata rows inside the member-projection atomic commit.
      cohortExecutionType: preparedCohort?.cohortExecutionType,
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
      coordinatedPages: preparedCohort?.coordinatedPages,
      // PR7 review R2 (F3.3): expected-empty marker — the child page stage
      // abstains with the clean legacy reason instead of warning about a
      // missing parent page output.
      pageCoordinationAbsent: preparedCohort?.pageCoordinationAbsent,
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
      ? new Set(
          preparedCohort!.sharedAuthorities.pageImportId &&
            preparedCohort!.sharedAuthorities.pages.state === 'verified'
            ? preparedCohort!.sharedAuthorities.pages.records.filter(r => r.verified).map(r => r.pageId)
            : [],
        )
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

    const searchKeywords = synthesizeSearchKeywords({
      title: curatedTitle,
      brand: ext.brand ?? item.brandHint,
      // Amendment B (M5b-2): a verified v2 distributor materialization's
      // materialized description contributes to keyword synthesis; v1 /
      // unverified / tampered distributor copy never does.
      description: distributorSource && !verifiedV2Distributor ? null : ext.description,
      suggestedPages,
      suggestedProductType,
      species: speciesLabels,
      lifeStage: ext.packagingOcrData?.lifeStage,
      productForm: ext.packagingOcrData?.productForm,
      attributes: attributeKeywords,
    });

    return {
      curatedTitle,
      searchKeywords,
      packagingOcrTitle,
      curatedWeight: convertToLbs(
        ext.packagingOcrData?.weight || ext.weight || extractWeightFromName(item.name) || null,
      ),
      titleSource: titleSource as 'web' | 'ocr' | 'llm' | 'manual' | 'llm_cohort' | 'cohort_fallback',
      curatedDescription,
      curatedDescriptionSourceAttemptIds,
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
      // only. `preparedCohort.effectiveType` is always present in cohort mode;
      // legacy (non-cohort) runs never carry the key (undefined keys are
      // dropped by JSON.stringify), keeping flag-OFF output byte-identical.
      effectiveProductType: cohortMode && preparedCohort!.effectiveType
        ? { id: preparedCohort!.effectiveType.id, source: preparedCohort!.effectiveType.source }
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
        const catMeta = result.stageOutputs.category_page_proposals;
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
        const effectiveTypeId = (cohortMode && preparedCohort!.effectiveType?.id) || suggestedProductType;
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
    preparedCohort?.assertOwnershipHeld?.();
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
