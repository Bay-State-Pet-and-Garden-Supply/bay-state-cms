/**
 * Packaging-OCR classification stage (packaging-ocr overhaul plan P2-T2).
 *
 * Runs packaging OCR as a FIRST-CLASS ADR-0004 stage (`packaging_ocr`)
 * registered BEFORE `evidence_extraction` (which declares it in `requires`),
 * so the OCR result is computed once per run and threaded to downstream stages
 * via `StageInput.stageOutputs` instead of being re-derived inline inside
 * `product-evidence-extractor`.
 *
 * Behavior contract:
 * - Flag OFF (`getOcrStageFlags().packagingOcrStageEnabled`, default) ⇒ the
 *   stage is INERT: it succeeds with zero evidence/proposals and writes
 *   nothing, so legacy behavior stays byte-identical.
 * - Frozen-cohort runs (`context.cohortFrozenEvidence`) are inert too — the
 *   frozen evidence stage materializes OCR from the projection with ZERO model
 *   calls; a live OCR attempt here would violate frozen-means-frozen.
 * - Distributor-record / null primaryImage ⇒ coded `skipped` / `no_image`
 *   outcome and the stage SUCCEEDS (skip-not-fail, mirroring
 *   stages/evidence-extraction.ts and distributor-record-materializer.ts).
 * - Run-bound discipline is IDENTICAL to the freeze pull-forward
 *   (`runFrozenOcrPullForward`): `requireModelCallContext` +
 *   `getModelExecutionPlanEntry` frozen-route resolution, plan-compat denial
 *   surfaces as a CODED failure (never a throw across the pipeline boundary),
 *   and `context.assertHeld` is passed through to every terminal audit write.
 * - Shadow-only mode computes everything but persists ONLY the namespaced
 *   `shadowPackagingOcrData` key + optional comparison rows — the live OCR
 *   authority keys (`packagingOcrData` / `packagingTitle` / `ocrOutcome` /
 *   `ocrInputHash` / `ocrExecutionDigest`) are never mutated.
 * - Non-shadow mode persists the live keys through the onboarding-item repo
 *   (same unconditional-overwrite shape as the freeze pull-forward), and
 *   downstream `evidence_extraction` consumes this stage's output INSTEAD of
 *   invoking inline OCR (see `getAuthoritativePackagingOcrStageOutput`).
 */
import { z } from 'zod';
import type {
  StageDefinition,
  StageContext,
  StageInput,
  StageResult,
  ClassificationStageName,
  StageOutput,
} from '../types';
import type { ModelCallContext } from '../model-operation-registry';
import type { RuntimeClassificationSnapshot } from '../runtime-snapshot';
import {
  findItemById,
  persistItemPackagingOcrResult,
  persistItemShadowPackagingOcrResult,
} from '../../db/repositories/onboarding-item-repo';
import { getLatestExtraction } from '../../db/repositories/onboarding-extraction-repo';
import { insertPackagingOcrShadowComparison, deleteOlderThan, parseOcrShadowRetentionDays } from '../../db/repositories/packaging-ocr-shadow-repo';
import { runPackagingOcrAttempt, mergeOcrResults } from '../../onboarding/packaging-ocr';
import { getVlmConfig } from '../../onboarding/vlm-client';
import { modelPolicyViewFromConfig } from '../../onboarding/model-policy-snapshot';
import {
  requireModelCallContext,
  getModelExecutionPlanEntry,
  computeOcrExecutionDigest,
} from '../runtime-snapshot';
import { HeartbeatLostError } from '../heartbeat-errors';
import { hashCanonicalJson } from '../../shared/stable-id';
import { getOcrStageFlags } from '../ocr-stage-flags';
import {
  OcrAttemptOutcomeSchema,
  OcrFailureReasonEnum,
  PackagingOcrDataSchema,
  type OcrAttemptOutcome,
  type OnboardingItem,
  type PackagingOcrData,
} from '../../shared/schemas/onboarding';

/** Scalar OCR fields whose non-null presence counts as usable content. */
const OCR_CONTENT_SCALAR_FIELDS = [
  'productName', 'brand', 'upc', 'size', 'weight', 'count',
  'flavorVariety', 'color', 'material', 'lifeStage', 'breedSize', 'productForm',
  'packagingType', 'npkRatio',
] as const;

/** Array OCR fields whose non-empty presence counts as usable content. */
const OCR_CONTENT_ARRAY_FIELDS = [
  'species', 'healthConcernFunction', 'dietaryLabels',
  'ingredients', 'ingredientKeywords', 'claims', 'visibleTextLines',
] as const;

/** True when a parsed OCR result carries usable content (same rule everywhere). */
function hasOcrContent(ocr: PackagingOcrData | undefined | null): boolean {
  if (!ocr) return false;
  for (const field of OCR_CONTENT_SCALAR_FIELDS) {
    const value = ocr[field];
    if (typeof value === 'string' && value.trim().length > 0) return true;
  }
  for (const field of OCR_CONTENT_ARRAY_FIELDS) {
    const arr = ocr[field];
    if (Array.isArray(arr) && arr.some(b => b && b.trim().length > 0)) return true;
  }
  return false;
}

/**
 * The canonical OCR input-set hash, byte-compatible with
 * `cohort-curator.computeOcrInputHash(item, extractionSourceUrl)` so a hash
 * written by THIS stage is verified by exactly the same freeze-time /
 * frozen-stage reuse guards. `extractionSourceUrl` resolves from the item's
 * LATEST `onboarding_extractions` row — the same binding the cohort freeze
 * recomputes the hash against.
 */
function computeStageOcrInputHash(params: {
  sourceUrl: string | null;
  extractionSourceUrl: string | null;
  primaryImage: string | null;
  additionalImages: string[];
}): string {
  return hashCanonicalJson({
    sourceUrl: params.sourceUrl ?? null,
    extractionSourceUrl: params.extractionSourceUrl ?? null,
    primaryImage: params.primaryImage ?? null,
    additionalImages: Array.isArray(params.additionalImages) ? params.additionalImages : [],
  });
}

// ─── Dual-run field agreement (P2-T4) ─────────────────────────────────────────

/** Scalar fields compared one-by-one in the dual-run comparison payload. */
const SCALAR_OCR_FIELDS = [
  'productName', 'brand', 'upc', 'flavorVariety', 'color', 'material',
  'size', 'weight', 'count', 'lifeStage', 'breedSize', 'productForm',
  'packagingType', 'npkRatio',
] as const;

const AGREEMENT_VALUE_CAP = 200;
const AGREEMENT_JSON_CAP = 8192;

export interface OcrFieldAgreement {
  agree: boolean;
  legacyValue?: string | null;
  stageValue?: string | null;
}

function capAgreementValue(value: unknown): string | null {
  if (value == null) return null;
  const str = String(value);
  return str.length > AGREEMENT_VALUE_CAP ? `${str.slice(0, AGREEMENT_VALUE_CAP)}` : str;
}

/**
 * Pure scalar-field comparison of the legacy inline vs stage PackagingOcrData.
 * Only scalar fields participate; values are length-capped and the serialized
 * map is size-capped so an observation row can never bloat.
 */
export function comparePackagingOcrResults(
  legacy: PackagingOcrData | null | undefined,
  stage: PackagingOcrData | null | undefined,
): Record<string, OcrFieldAgreement> {
  const agreement: Record<string, OcrFieldAgreement> = {};
  if (!legacy || !stage) return agreement;
  let size = 2; // '{}'
  for (const field of SCALAR_OCR_FIELDS) {
    const legacyValue = capAgreementValue(legacy[field]);
    const stageValue = capAgreementValue(stage[field]);
    const entry: OcrFieldAgreement = {
      agree: (legacyValue ?? null) === (stageValue ?? null),
      ...(legacyValue != null ? { legacyValue } : {}),
      ...(stageValue != null ? { stageValue } : {}),
    };
    const serialized = `"${field}":${JSON.stringify(entry)}`;
    if (size + serialized.length > AGREEMENT_JSON_CAP) break;
    agreement[field] = entry;
    size += serialized.length + 1;
  }
  return agreement;
}

/** First human-meaningful failure reason carried by an outcome (already redacted upstream). */
function outcomeReason(outcome: Record<string, any> | null | undefined): string | null {
  if (!outcome || typeof outcome !== 'object') return null;
  const reason = outcome.localFailureReason ?? outcome.cloudFailureReason ?? outcome.error ?? outcome.reason ?? null;
  return reason == null ? null : String(reason);
}

// ─── Persisted-shape schemas ──────────────────────────────────────────────────

/** Zod validation of the payload persisted into extraction_data_json (P2-T2). */
export const PackagingOcrStagePersistPayloadSchema = z.object({
  itemId: z.string().min(1),
  packagingOcrData: z.record(z.string(), z.unknown()).nullable(),
  packagingTitle: z.string().nullable(),
  ocrOutcome: z.record(z.string(), z.unknown()).nullable(),
  ocrInputHash: z.string().nullable(),
  ocrExecutionDigest: z.string().nullable(),
  /** P2 baseline-drift guard marker — persisted as extraction_data_json key
   *  `packagingOcrStageRunId` by the repository (absent for legacy writes). */
  stageRunId: z.string().min(1).optional(),
});

/**
 * The authoritative stage output metadata consumed by `evidence_extraction`
 * via `input.stageOutputs.packaging_ocr.metadata` (threaded by the pipeline
 * runner). Validated before consumption — a malformed/abstained/shadow output
 * NEVER becomes authoritative.
 */
const AuthoritativeStageOutputSchema = z.object({
  packagingOcrData: z.record(z.string(), z.unknown()),
  ocrOutcome: z.record(z.string(), z.unknown()).nullish(),
  ocrInputHash: z.string().nullish(),
  ocrExecutionDigest: z.string().nullish(),
  shadowOnly: z.literal(false).optional(),
});

/**
 * Resolve the FRESH packaging_ocr stage output for THIS run, if the stage ran
 * non-shadow and produced data. The payload is validated against
 * `PackagingOcrDataSchema` before it can ever become authoritative. Returns
 * null otherwise (flag off, shadow-only run, skip outcomes, malformed payload,
 * or no stage output at all) — callers fall back to their legacy path unchanged.
 */
export function getAuthoritativePackagingOcrStageOutput(
  stageOutputs: Partial<Record<ClassificationStageName, StageOutput>> | undefined,
): {
  packagingOcrData: PackagingOcrData;
  ocrOutcome: Record<string, unknown> | null;
  ocrInputHash: string | null;
  ocrExecutionDigest: string | null;
} | null {
  const metadata = stageOutputs?.packaging_ocr?.metadata as Record<string, unknown> | undefined;
  if (!metadata) return null;
  const parsed = AuthoritativeStageOutputSchema.safeParse(metadata);
  if (!parsed.success) return null;
  const ocrData = PackagingOcrDataSchema.safeParse(parsed.data.packagingOcrData);
  if (!ocrData.success) return null;
  return {
    packagingOcrData: ocrData.data,
    ocrOutcome: parsed.data.ocrOutcome ?? null,
    ocrInputHash: parsed.data.ocrInputHash ?? null,
    ocrExecutionDigest: parsed.data.ocrExecutionDigest ?? null,
  };
}

// ─── Freeze-time OCR moment delegation (P2-T6) ──────────────────────────────────

export interface FreezeOcrStageDelegationParams {
  /** The member's frozen runtime snapshot — run-bound discipline identical
   *  to the legacy freeze pull-forward (`requireModelCallContext` + frozen
   *  route resolution happen INSIDE the stage). */
  snapshot: RuntimeClassificationSnapshot;
  /** The member CHILD run id — every model-call audit row lands on it. */
  childRunId: string;
  /** The live onboarding item being frozen (must be a materialized DB row). */
  item: OnboardingItem;
  workspacePath: string;
  /** Ownership assertion forwarded to the stage → transport terminal updates
   *  (PR3 hardening C semantics preserved through delegation). */
  assertHeld?: () => void;
}

/**
 * Execute THIS stage as the cohort freeze's authoritative OCR moment
 * (P2-T6 ordered consumer migration, step 1). The caller (`cohort-curator.
 * runFrozenOcrPullForward`) stays the authority: it keeps ALL gating
 * (settled / input-hash / digest-staleness / re-run cap), the scoped lease
 * keeper, and the hash/digest binding write-back — only the OCR computation
 * itself is delegated here. The returned shape matches the legacy
 * `runFrozenOcrPullForward` contract exactly so the existing write-back is
 * byte-compatible.
 *
 * NOTE: the stage context deliberately carries NO `cohortFrozenEvidence` —
 * inside a member PIPELINE the frozen projection owns OCR (the stage is
 * inert); at FREEZE time the projection does not exist yet and this stage
 * invocation IS the OCR moment. The stage's own non-shadow persistence is
 * harmless: the freeze write-back immediately rebinds the same live keys to
 * the authoritative current input hash + execution digest.
 */
export async function runPackagingOcrStageForFreeze(
  params: FreezeOcrStageDelegationParams,
): Promise<{ packagingOcrData: PackagingOcrData | null; ocrOutcome: OcrAttemptOutcome }> {
  const context = {
    workspacePath: params.workspacePath,
    workspaceId: params.snapshot.workspaceId,
    configSnapshotRef: params.snapshot.configSnapshotRef,
    snapshot: params.snapshot,
    runId: params.childRunId,
    ...(params.assertHeld ? { assertHeld: params.assertHeld } : {}),
  } as StageContext;
  const input: StageInput = {
    sku: params.item.upc,
    onboardingItemId: params.item.id,
    evidence: [],
    acceptedProposals: [],
    allProposals: [],
  };

  const result = await packagingOcrStage.execute(input, context);
  const metadata = (result.status === 'succeeded' ? result.output.metadata ?? {} : {}) as Record<string, unknown>;
  // Validate the stage payload before it can become the freeze's bound OCR —
  // shadow-only metadata (shadowOnly: true) still carries the computed data,
  // which is fine HERE: the freeze write-back (not the stage persist) is the
  // authority that binds data + hashes into extraction_data_json.
  const ocrData = PackagingOcrDataSchema.safeParse(metadata.packagingOcrData ?? null);
  let outcome = OcrAttemptOutcomeSchema.safeParse(metadata.ocrOutcome ?? null);
  // Freeze-convergence parity with the legacy pull-forward: the stage emits
  // status 'skipped' for distributor_record items (its pipeline-level
  // skip-not-fail code), but the settled checks (`isOcrSettled` in this
  // module and curation-cohort-service.ts) treat ONLY
  // succeeded|disabled|failed|no_image as terminal. Persisting 'skipped'
  // here would leave the member permanently unsettled — every subsequent
  // freeze pass re-runs the OCR moment and churns comparison rows. Mapping
  // 'skipped' → 'no_image' at THIS boundary keeps the stage's pipeline-level
  // vocabulary untouched while giving the freeze a terminal outcome (the
  // legacy pull-forward already converges because its distributor handling
  // settles as no usable image). Delegation itself is not skipped for
  // distributor items so the freeze write-back still binds fresh hashes.
  if (outcome.success && outcome.data.status === 'skipped') {
    outcome = OcrAttemptOutcomeSchema.safeParse({ ...outcome.data, status: 'no_image', localStatus: 'no_image' });
  }
  return {
    packagingOcrData: ocrData.success ? ocrData.data : null,
    ocrOutcome: outcome.success
      ? outcome.data
      : OcrAttemptOutcomeSchema.parse({ status: 'failed', localStatus: 'failed', imageCount: 0 }),
  };
}

// ─── Stage definition ─────────────────────────────────────────────────────────

const succeededEmpty = (metadata?: Record<string, unknown>): StageResult => ({
  status: 'succeeded',
  output: { evidence: [], proposals: [], abstained: false, ...(metadata ? { metadata } : {}) },
});

/**
 * The `packaging_ocr` classification stage.
 *
 * Flag OFF ⇒ fully INERT: succeeds with empty output and touches NOTHING
 * (no DB writes, no transports), so legacy behavior is byte-identical.
 *
 * Flag ON: executes `runPackagingOcrAttempt` over primaryImage + additional
 * images up to a TOTAL cap of 2 (today's exact semantics from
 * product-evidence-extractor / cohort-curator), merges multi-image results via
 * `mergeOcrResults`, computes the input hash +
 * `computeOcrExecutionDigest(snapshot)` and persists the result through the
 * repository layer.
 */
export const packagingOcrStage: StageDefinition = {
  name: 'packaging_ocr',
  requires: [],
  evidenceFrom: [],
  execute: async (input: StageInput, context: StageContext): Promise<StageResult> => {
    const flags = getOcrStageFlags();
    // Flag OFF (incl. PI kill-switch dominance resolved inside the flags):
    // inert success — no reads beyond flags, no writes, no transport.
    // Frozen-cohort members own their OCR via the projection; never re-run here.
    if (!flags.packagingOcrStageEnabled || context.cohortFrozenEvidence) {
      return succeededEmpty({
        skipped: true,
        reason: !flags.packagingOcrStageEnabled ? 'packaging_ocr_stage_disabled' : 'frozen_projection_owns_ocr',
      });
    }

    if (!input.onboardingItemId) {
      return { status: 'abstained', reason: 'No onboarding item ID available for packaging OCR.' };
    }

    const item = findItemById(input.onboardingItemId);
    if (!item) {
      return { status: 'abstained', reason: 'No onboarding item found for packaging OCR.' };
    }

    const ext: Record<string, any> = { ...((item.extractionData ?? {}) as Record<string, any>) };

    // Skip-not-fail precedent (stages/evidence-extraction.ts distributor branch,
    // distributor-record-materializer.ts): distributor records produce a coded
    // outcome and the stage SUCCEEDS.
    if (item.sourceType === 'distributor_record') {
      const ocrOutcome = OcrAttemptOutcomeSchema.parse({
        status: 'skipped',
        localStatus: 'skipped',
        imageCount: 0,
      });
      // P2 stale-shadow hygiene: a distributor transition must not leave a
      // stale shadow observation presenting itself as current. Shadow mode
      // clears its namespaced key before this early return — ownership-
      // asserted and CAS-guarded against the value observed at stage start,
      // so a concurrent writer is never erased by a stale owner.
      if (flags.packagingOcrStageShadowOnly) {
        context.assertHeld?.();
        persistItemShadowPackagingOcrResult(item.id, null, {
          expectedPrevious: (item.extractionData as Record<string, unknown> | null | undefined)?.shadowPackagingOcrData ?? null,
        });
      }
      return succeededEmpty({ ocrOutcome, skipped: 'distributor_record', shadowOnly: flags.packagingOcrStageShadowOnly });
    }

    // Legacy inline result captured BEFORE any write — the dual-run baseline.
    const legacyOutcome = (ext.ocrOutcome && typeof ext.ocrOutcome === 'object' ? ext.ocrOutcome : null) as Record<string, any> | null;
    const legacyData = (ext.packagingOcrData && typeof ext.packagingOcrData === 'object' ? ext.packagingOcrData : null);
    // P2 baseline-drift guard: once THIS stage has persisted live authority
    // keys, those keys are stage-authored — a later run reading them as the
    // "legacy" side would compare stage-vs-stage. The marker key is written
    // together with the live keys by persistItemPackagingOcrResult and is
    // never set by the legacy inline path.
    const baselineIsStageAuthored = typeof ext.packagingOcrStageRunId === 'string' && ext.packagingOcrStageRunId.length > 0;

    // Image set: primary + additionalImages up to a TOTAL of 2 — the exact cap
    // loop used by product-evidence-extractor.ts / cohort-curator.ts today.
    const imageUrls: string[] = [];
    if (ext.primaryImage) imageUrls.push(String(ext.primaryImage));
    if (Array.isArray(ext.additionalImages)) {
      for (const img of ext.additionalImages) {
        if (imageUrls.length >= 2) break;
        if (img && String(img).trim()) imageUrls.push(String(img));
      }
    }

    const sku = item.upc;

    // No usable images at all (null primaryImage AND no additionalImages)
    // ⇒ coded `no_image`, stage SUCCEEDS (skip-not-fail). An item with ONLY
    // additionalImages still gets its body images OCR'd through the normal
    // loop below.
    if (imageUrls.length === 0) {
      const ocrOutcome = OcrAttemptOutcomeSchema.parse({
        status: 'no_image',
        localStatus: 'no_image',
        imageCount: 0,
      });
      if (!flags.packagingOcrStageShadowOnly) {
        persistItemPackagingOcrResult({
          itemId: item.id,
          packagingOcrData: null,
          packagingTitle: null,
          ocrOutcome,
          ocrInputHash: null,
          ocrExecutionDigest: null,
          ...(context.runId ? { stageRunId: context.runId } : {}),
        });
      } else {
        // P2 stale-shadow hygiene: shadow runs own ONLY the namespaced key;
        // a no-image run must still clear any prior observation — ownership-
        // asserted and CAS-guarded like the distributor branch above.
        context.assertHeld?.();
        persistItemShadowPackagingOcrResult(item.id, null, {
          expectedPrevious: (item.extractionData as Record<string, unknown> | null | undefined)?.shadowPackagingOcrData ?? null,
        });
      }
      return succeededEmpty({ ocrOutcome, shadowOnly: flags.packagingOcrStageShadowOnly });
    }

    // FIX-B review round 2: mutable settings are read ONLY for legacy
    // (snapshot-less) callers. A run-bound leg's availability comes from the
    // FROZEN plan entry alone, and the reported model never falls back to
    // the mutable setting — a snapshot-bound disabled outcome must not leak
    // whatever `ollama_vlm` happens to hold mid-run.
    const vlmConfig = context.snapshot ? null : getVlmConfig();
    // Frozen-route authority: when a run snapshot is bound, local-VLM
    // availability derives from the FROZEN plan entry only — mutable
    // `ollama_vlm` settings never enable or disable a run-bound OCR leg.
    // Legacy (snapshot-less) callers keep the mutable-settings check.
    const frozenPlanEntry = context.snapshot
      ? getModelExecutionPlanEntry(context.snapshot, 'evidence_extraction')
      : null;
    const canUseLocalVlm = context.snapshot
      ? Boolean(frozenPlanEntry?.localVlmBaseUrl && frozenPlanEntry?.localVlmModel)
      : vlmConfig?.enabled === true;
    const dataPolicy = context.snapshot
      ? (context.snapshot.dataSharing as { textPolicy?: string; imagePolicy?: string } | undefined)
      : undefined;
    const canUseCloudImages = dataPolicy?.imagePolicy === 'cloud_allowed';

    let localStatus: OcrAttemptOutcome['status'] = canUseLocalVlm ? 'skipped' : 'disabled';
    let cloudStatus: OcrAttemptOutcome['status'] = canUseCloudImages ? 'skipped' : 'disabled';
    let localFailureReason: z.infer<typeof OcrFailureReasonEnum> | null = null;
    let localAttempts = 0;

    const ocrResults: PackagingOcrData[] = [];
    let packagingOcrData: PackagingOcrData | undefined;
    let localOcrSucceeded = false;

    if (canUseLocalVlm) {
      localStatus = 'failed';
      // Frozen policy view + run-bound call context ONCE — copied from
      // cohort-curator.runFrozenOcrPullForward. A plan-compat denial is a
      // CODED failure recorded on the outcome, never a throw.
      const evidencePolicyView = context.snapshot
        ? modelPolicyViewFromConfig(
            context.snapshot.modelPolicy as Parameters<typeof modelPolicyViewFromConfig>[0],
            context.snapshot.snapshotHash,
          )
        : null;
      let localModelCall: ModelCallContext | null = null;
      let localFrozenRoute: { baseUrl: string; model: string } | null = null;
      if (context.snapshot) {
        try {
          localModelCall = requireModelCallContext(context.snapshot, context.runId, 'evidence_extraction', 1);
          const entry = getModelExecutionPlanEntry(context.snapshot, 'evidence_extraction');
          if (entry?.localVlmBaseUrl && entry?.localVlmModel) {
            localFrozenRoute = { baseUrl: entry.localVlmBaseUrl, model: entry.localVlmModel };
          }
        } catch (err) {
          console.warn(
            `[PackagingOcrStage] SKU ${sku}: no compatible frozen plan — ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      for (let i = 0; i < imageUrls.length; i++) {
        const imgUrl = imageUrls[i];
        // Run-bound without a compatible plan → no transport for ANY image.
        if (context.snapshot && !localModelCall) continue;
        try {
          const attempt = await runPackagingOcrAttempt({
            imageUrl: imgUrl,
            workspacePath: context.workspacePath,
            imageSourceUrl: imgUrl,
            sku,
            ...(localModelCall && context.snapshot
              ? {
                  modelCall: localModelCall,
                  snapshot: context.snapshot,
                  frozenVlmRoute: localFrozenRoute,
                  modelPolicyDigest: evidencePolicyView?.policyDigest ?? '',
                }
              : {}),
            assertHeld: context.assertHeld,
            // Injectable transport (StageContext.modelFetchFn): test harnesses
            // bind this to their local server so cross-file globalThis.fetch
            // stubs can never intercept the stage transport. Omitted in prod.
            ...(context.modelFetchFn ? { modelFetchFn: context.modelFetchFn } : {}),
          });
          if (attempt.ok) {
            if (hasOcrContent(attempt.data)) ocrResults.push(attempt.data);
          } else {
            localFailureReason = attempt.reasonCode;
            localAttempts = Math.max(localAttempts, attempt.attempts);
          }
        } catch (err) {
          // Ownership loss aborts immediately — a stale owner never continues.
          if (err instanceof HeartbeatLostError) throw err;
          console.warn(`[PackagingOcrStage] OCR failed for image ${i + 1}/${imageUrls.length} of SKU ${sku}: ${err instanceof Error ? err.message : String(err)}`);
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

    // Cloud multimodal VLM fallback (identical gating to the freeze pull-forward).
    if (!localOcrSucceeded && ext.primaryImage && canUseCloudImages) {
      cloudStatus = 'failed';
      try {
        const evidencePolicyView = context.snapshot
          ? modelPolicyViewFromConfig(
              context.snapshot.modelPolicy as Parameters<typeof modelPolicyViewFromConfig>[0],
              context.snapshot.snapshotHash,
            )
          : null;
        const { extractPackagingOcrFromCloud } = await import('../../onboarding/cloud-vlm-client');
        let cloudModelCall: ModelCallContext | null = null;
        if (context.snapshot) {
          try {
            cloudModelCall = requireModelCallContext(context.snapshot, context.runId, 'evidence_extraction', 1);
          } catch (err) {
            console.warn(
              `[PackagingOcrStage] Cloud OCR for SKU ${sku} abstained: no compatible frozen plan — ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        if (cloudModelCall && context.snapshot) {
          const cloudOcrResult = await extractPackagingOcrFromCloud({
            imageUrl: String(ext.primaryImage),
            modelPolicy: evidencePolicyView,
            modelCall: cloudModelCall,
            snapshot: context.snapshot,
          });
          if (cloudOcrResult && hasOcrContent(cloudOcrResult)) {
            packagingOcrData = cloudOcrResult;
            cloudStatus = 'succeeded';
          }
        }
      } catch (err) {
        if (err instanceof HeartbeatLostError) throw err;
        console.warn(`[PackagingOcrStage] Cloud packaging OCR failed for SKU ${sku}: ${err instanceof Error ? err.message : String(err)}`);
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

    const ocrOutcome: OcrAttemptOutcome = OcrAttemptOutcomeSchema.parse({
      status: overallStatus,
      localStatus,
      cloudStatus,
      // FIX-B review round 2: snapshot-bound runs report the model from OCR
      // metadata or the frozen plan entry ONLY — never the mutable setting.
      model: packagingOcrData?.metadata?.model
        ?? (context.snapshot ? (frozenPlanEntry?.localVlmModel ?? null) : (vlmConfig?.model ?? null)),
      imageCount: imageUrls.length,
      ...(localFailureReason ? { localFailureReason } : {}),
      ...(localAttempts > 0 ? { attempts: localAttempts } : {}),
    });

    // Input-hash + execution-authority digest bound EXACTLY like the freeze
    // pull-forward write-back.
    const extractionSourceUrl = getLatestExtraction(item.id)?.source_url ?? null;
    const ocrInputHash = computeStageOcrInputHash({
      sourceUrl: item.sourceUrl ?? null,
      extractionSourceUrl,
      primaryImage: ext.primaryImage ?? null,
      additionalImages: Array.isArray(ext.additionalImages) ? ext.additionalImages : [],
    });
    const ocrExecutionDigest = context.snapshot ? computeOcrExecutionDigest(context.snapshot) : null;

    // ── Persistence (P2-T2/P2-T4 isolation boundary) ────────────────────────
    if (flags.packagingOcrStageShadowOnly) {
      // SHADOW: compute everything, write ONLY the namespaced key. Live
      // authority keys stay untouched by construction.
      persistItemShadowPackagingOcrResult(
        item.id,
        packagingOcrData ? (JSON.parse(JSON.stringify(packagingOcrData)) as Record<string, unknown>) : null,
      );
    } else {
      const payload = PackagingOcrStagePersistPayloadSchema.parse({
        itemId: item.id,
        packagingOcrData: packagingOcrData ? JSON.parse(JSON.stringify(packagingOcrData)) : null,
        packagingTitle: packagingOcrData?.productName ?? null,
        ocrOutcome: ocrOutcome as unknown as Record<string, unknown>,
        ocrInputHash,
        ocrExecutionDigest,
        ...(context.runId ? { stageRunId: context.runId } : {}),
      });
      persistItemPackagingOcrResult(payload);
    }

    // Dual-run comparison (P2-T4): only when BOTH sides exist for the same
    // item/run — the legacy inline result must already be stored AND must not
    // be stage-authored from an earlier non-shadow persist (baseline-drift
    // guard above): comparing the stage against its own earlier output would
    // produce meaningless agreement rows.
    if (
      flags.packagingOcrDualRunCompare &&
      !baselineIsStageAuthored &&
      (legacyOutcome !== null || legacyData !== null)
    ) {
      try {
        const fieldAgreement = comparePackagingOcrResults(
          legacyData as PackagingOcrData | null,
          packagingOcrData ?? null,
        );
        insertPackagingOcrShadowComparison({
          itemId: item.id,
          batchId: item.batchId ?? null,
          runId: context.runId,
          legacyStatus: typeof legacyOutcome?.status === 'string' ? legacyOutcome.status : null,
          legacyReason: outcomeReason(legacyOutcome),
          stageStatus: ocrOutcome.status,
          stageReason: outcomeReason(ocrOutcome as unknown as Record<string, any>),
          fieldAgreementJson: Object.keys(fieldAgreement).length > 0 ? JSON.stringify(fieldAgreement) : null,
        });
        // Retention (post-review fixup 6): after each successful write, prune
        // observation rows older than the configured window. Single DELETE —
        // cheap enough to piggyback here, and it keeps the ONE write-side
        // lifecycle call site co-located with the producer.
        const retentionDays = parseOcrShadowRetentionDays(process.env.BAYSTATE_CMS_OCR_SHADOW_RETENTION_DAYS);
        deleteOlderThan(new Date(Date.now() - retentionDays * 86_400_000).toISOString());
      } catch (err) {
        // Observation rows are diagnostics only — never fail the stage.
        console.warn(`[PackagingOcrStage] Shadow comparison row failed for SKU ${sku}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return succeededEmpty({
      ocrOutcome: ocrOutcome as unknown as Record<string, unknown>,
      ...(packagingOcrData
        ? {
            packagingOcrData: JSON.parse(JSON.stringify(packagingOcrData)) as Record<string, unknown>,
            ocrInputHash,
            ocrExecutionDigest,
          }
        : {}),
      shadowOnly: flags.packagingOcrStageShadowOnly,
    });
  },
};
