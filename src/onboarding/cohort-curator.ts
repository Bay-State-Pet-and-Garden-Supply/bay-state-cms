/**
 * Cohort curator — the PR3 M2 freeze engine (issue #30).
 *
 * The ONLY path from `freezing → running` for a parent cohort run. Two-phase
 * freeze (implementation-plan section D):
 *
 * 1. capture the common authorities ONCE (config authority + persisted config
 *    snapshot ref — FAIL CLOSED for an active v2 authority whose bundle hash
 *    has no persisted `classification_config_snapshots` row; verified Page
 *    catalog identity; the H5 model-execution digest; frozen fieldOptions);
 * 2. per member: idempotent `ensureMemberRun`, build + persist the member
 *    runtime snapshot WITH the frozen fieldOptions injected, run-bound OCR
 *    pull-forward when the stored OCR is unsettled or its input set changed,
 *    persist OCR back into `extraction_data_json`, recompute the member hash;
 * 3. FINAL CAS TRANSACTION: reload cohort + members + items, verify the
 *    candidate is still ready / non-superseded, membership hash unchanged,
 *    every member's current evidence hash + `ocrInputHash` still match the
 *    frozen values, and config/page/policy digests unchanged. On match the
 *    content-addressed `classification_cohort_snapshots` row is persisted
 *    (execution-evidence-v1 projection), H1–H5 + `evidence_snapshot_id` are
 *    written onto the run, and the run transitions to `running` — all in ONE
 *    transaction. On ANY mismatch the run is superseded (and its linked
 *    running children failed): execution NEVER starts from a mixed-time
 *    snapshot.
 *
 * This module also exposes:
 * - `buildExecutionEvidenceProjection` — the pure `execution-evidence-v1`
 *   projection builder (contract C);
 * - `verifyCohortRunFrozen` — the production `verifyFrozen` implementation for
 *   lease reclaim (resume-on-match / supersede-on-drift);
 * - `PreparedCohortContext` — the prepared-cohort input contract consumed by
 *   `curateItemWithPipeline` (amendment 6).
 */
import { getDb } from '../db/connection';
import {
  getCohortById,
  getCohortMembers,
  listCohortsByWorkspace,
  computeExtractionHash,
  computeMembershipHash,
} from '../db/repositories/curation-cohort-repo';
import {
  ensureMemberRun,
  freezeCohortRunAuthorities,
  transitionCohortRunToRunning,
  supersedeCohortRunIfUnchanged,
  persistCohortSnapshot,
  getCohortRunById,
  completeCohortRun,
  heartbeatCohortRun,
  cancelFreezingRun,
  getCohortSnapshotByHash,
  writeExecutionProductType,
  writeFinalMembershipHash,
  writeProductTypeOutcomeOnly,
  failFrozenCohortRunForConflict,
  supersedeOwnedCohortRunForOutputDrift,
  insertProposalDependency,
  writeCohortBrandSemanticUpdates,
  COHORT_LEASE_TTL_MS,
} from '../db/repositories/classification-cohort-run-repo';
import {
  listItemsByBatch,
  findItemById,
  updateItemExtractionData,
  updateItemStageStatus,
  updateItemCurationData,
} from '../db/repositories/onboarding-item-repo';
import { getOcrStageFlags } from '../classification/ocr-stage-flags';
import { runPackagingOcrStageForFreeze } from '../classification/stages/packaging-ocr-stage';
import {
  getLatestExtractionBindingsByItemIds,
  type ExtractionBinding,
} from '../db/repositories/onboarding-extraction-repo';
import { completeRun, createRun } from '../db/repositories/classification-run-repo';
import type { ClassificationRunRow } from '../db/repositories/classification-run-repo';
import {
  syncConfigToCache,
  createConfigSnapshot,
  getPersistedConfigSnapshotId,
  upsertConfigSnapshot,
} from '../db/repositories/classification-config-repo';
import { loadRuntimeConfigAuthority, createRuntimeActivationContext } from '../classification/config-loader';
import type { RuntimeConfigAuthority } from '../classification/config-loader';
import { captureVerifiedPageSnapshot, toPageSnapshotState } from '../classification/page-snapshot';
import { assertClassificationReady } from '../classification/readiness';
import {
  buildRuntimeSnapshot,
  persistRuntimeSnapshot,
  computeSnapshotFieldOptions,
  captureLocalVlmConfig,
  requireModelCallContext,
  getModelExecutionPlanEntry,
  getRuntimeSnapshotByHash,
  computeOcrExecutionDigest,
  buildModelCallContext,
} from '../classification/runtime-snapshot';
import type {
  PageSnapshotState,
  RuntimeClassificationSnapshot,
} from '../classification/runtime-snapshot';
import { buildModelPolicyView } from '../classification/model-policy-gateway';
import type { ModelPolicyView } from '../classification/model-policy-gateway';
import { buildModelExecutionPlan, buildRuntimeRuleVersions } from '../classification/model-operation-registry';
import type { ModelCallContext, ModelExecutionPlan, RuntimeRuleVersions } from '../classification/model-operation-registry';
import { modelPolicyViewFromConfig } from './model-policy-snapshot';
import { getCohortCurationFlags } from '../classification/flags';
import {
  evidenceFromProjection,
  matchMemberDeterministically,
  resolveCohortProductType,
  mapRankedLabelToOptionExactlyOne,
} from '../classification/cohort-product-type-resolver';
import type {
  CohortProductTypeResolution,
  ConfidentMemberProductTypeResult,
  MemberLlmRankResult,
  CohortMemberInput,
} from '../classification/cohort-product-type-resolver';
import { resolveTargetsFromSnapshot } from '../classification/curation-target-resolver';
import { getEffectiveCurationTypeForSnapshot, getReviewedTypeFromSnapshot, resolveEffectiveTypeProfile } from '../classification/effective-curation-type';
import { isUniversalAttribute } from '../classification/applicability-evaluator';
import {
  validateMemberSemantics,
  validateMemberLocalAttributes,
  validateCohortBrandCoherence,
  mergeSemanticFindings,
  isBlockingSemanticFinding,
} from '../classification/cohort-semantic-validator';
import type { CohortSemanticFinding } from '../classification/cohort-semantic-validator';
import { buildEvidenceTargetPacket } from '../classification/evidence-targeting';
import { FAMILY_TITLE_CONSISTENCY_VERSION } from '../classification/family-title-consistency';
import { llmRankOptions } from '../classification/curation-target-ranker';
import { HeartbeatLostError } from '../classification/heartbeat-errors';
export { HeartbeatLostError };
import { CohortLeaseKeeper } from './cohort-lease-keeper';
import { onboardingEvents } from './sse-emitter';
import { redactTransportText } from '../classification/model-policy-gateway';
import type { ProductLineItemSnapshot, CoordinatedPageMemberValue } from '../classification/types';
import { getVlmConfig } from './vlm-client';
import { runPackagingOcrAttempt, mergeOcrResults } from './packaging-ocr';
import { curateItemWithPipeline } from './product-curator';
import { ensureCohortTitlesCoordinated, CohortTitleAuthorityDriftError, CohortTitleOutputCorruptError } from './cohort-title-coordinator';
import {
  ensureCohortPagesCoordinated,
  CohortPageAuthorityDriftError,
  CohortPageOutputCorruptError,
} from './cohort-page-coordinator';
import { groupByProductLine } from './cohort-name-coordinator';
import { hashCanonicalJson, canonicalJsonStringify } from '../shared/stable-id';
import {
  PROJECTION_VERSION_V2,
  PROJECTION_VERSION_V3,
  ExecutionEvidenceProjectionV2Schema,
  ExecutionEvidenceProjectionV3Schema,
  parseExecutionEvidenceProjection,
  normalizeExecutionEvidenceProjectionMemberV1,
  normalizeExecutionEvidenceProjectionMemberV2,
  normalizeExecutionEvidenceProjectionV1ToV3,
} from '../shared/schemas/cohorts';
import type {
  CohortRun,
  CurationCohort,
  CurationCohortMember,
  ExecutionEvidenceProjectionMemberV2,
  ExecutionEvidenceProjectionMemberV3,
  ExecutionEvidenceProjectionMemberV1,
  ExecutionEvidenceProjectionMember,
  ExecutionEvidenceProjectionV2,
  ExecutionEvidenceProjectionV3,
  ExecutionProductTypeOutcome,
  CohortTitleOutput,
} from '../shared/schemas/cohorts';
import type {
  OnboardingItem,
  PackagingOcrData,
  OcrAttemptOutcome,
  CurationData,
} from '../shared/schemas/onboarding';
import type { ClassificationConfigSnapshotRef } from '../shared/schemas/classification';
import type { ResolvedTargetOption } from '../classification/curation-target-resolver';

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
function cohortProductTypeConfidenceFloor(): number {
  return getCohortCurationFlags().cohortProductTypeConfidenceFloor;
}

// Re-exported so tests keep importing the OCR execution-authority digest from
// the cohort module; the implementation lives with the runtime snapshot it
// derives from (runtime-snapshot.ts).
export { computeOcrExecutionDigest };

// ─── ocrInputHash (amendment 7) ────────────────────────────────────────────────

/**
 * SHA-256 over the canonical `{sourceUrl, extractionSourceUrl, primaryImage,
 * additionalImages}` set a packaging OCR attempt is bound to. A terminal
 * `ocrOutcome` alone is NOT sufficient: freeze finalization (and the frozen
 * evidence stage) verify the input set still matches `ocrInputHash` before
 * trusting a stored OCR result — mismatch means the OCR belongs to different
 * inputs → re-run OCR (or block).
 */
export function computeOcrInputHash(item: OnboardingItem, extractionSourceUrl: string | null): string {
  const ext = item.extractionData;
  return hashCanonicalJson({
    sourceUrl: item.sourceUrl ?? null,
    extractionSourceUrl: extractionSourceUrl ?? null,
    primaryImage: ext?.primaryImage ?? null,
    additionalImages: Array.isArray(ext?.additionalImages) ? ext.additionalImages : [],
  });
}

/** The ocrInputHash recorded with the item's stored OCR (top-level marker in
 *  extraction_data_json), or null when no attempt has recorded one. */
function storedOcrInputHash(item: OnboardingItem): string | null {
  const ext = item.extractionData as { ocrInputHash?: unknown } | null | undefined;
  return ext && typeof ext.ocrInputHash === 'string' ? ext.ocrInputHash : null;
}

/** The ocrExecutionDigest recorded with the item's stored OCR (top-level
 *  marker in extraction_data_json, alongside ocrInputHash), or null when the
 *  stored OCR predates the execution-authority binding (unknown authority ⇒
 *  the reuse guard fails closed — Commit A2: reuse requires BOTH the stored
 *  and the current digest to be non-null and equal). */
function storedOcrExecutionDigest(item: OnboardingItem): string | null {
  const ext = item.extractionData as { ocrExecutionDigest?: unknown } | null | undefined;
  return ext && typeof ext.ocrExecutionDigest === 'string' ? ext.ocrExecutionDigest : null;
}

/** OCR is settled ⇔ structured OCR data exists OR the attempt reached a
 *  terminal outcome (`succeeded | disabled | failed | no_image`). Mirrors the
 *  curation-cohort-service readiness check (curation-cohort-service.ts).
 *  P1-T3: a stale-marked OCR outcome (digest-staleness invalidation marker,
 *  below) is NEVER settled — prior `packagingOcrData` may be preserved intact
 *  for diagnostics, but it was executed under a superseded execution
 *  authority and must not be reused or treated as done. */
function isOcrSettled(item: OnboardingItem): boolean {
  const ext = item.extractionData;
  if (!ext) return false;
  if ((ext.ocrOutcome ?? null)?.stale === true) return false;
  if (ext.packagingOcrData) return true;
  const status = (ext as { ocrOutcome?: { status?: string } | null }).ocrOutcome?.status;
  if (!status) return false;
  return status === 'succeeded' || status === 'disabled' || status === 'failed' || status === 'no_image';
}

/** Scalar OCR fields whose non-null presence counts as usable content. */
const OCR_CONTENT_SCALAR_FIELDS = [
  'productName', 'brand', 'upc', 'size', 'weight', 'count',
  'flavorVariety', 'color', 'material', 'lifeStage', 'breedSize', 'productForm',
] as const;

/** Array OCR fields whose non-empty presence counts as usable content. */
const OCR_CONTENT_ARRAY_FIELDS = [
  'species', 'healthConcernFunction', 'dietaryLabels',
  'ingredients', 'ingredientKeywords', 'claims', 'visibleTextLines',
] as const;

/** True when a parsed OCR result carries usable content (same rule as the
 *  evidence extractor). */
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

// ─── Digest-staleness re-run trigger (P1-T3) ──────────────────────────────

/** Default per-freeze cap on digest-staleness OCR re-runs (stampede guard:
 *  one authority change must not fan out into an unbounded VLM burst). */
const DEFAULT_FREEZE_OCR_RERUN_CAP = 12;

/**
 * Parse `BAYSTATE_CMS_FREEZE_OCR_RERUN_CAP` (P1-T3 stampede guard): integer
 * ≥ 0, default 12; missing/unparseable/negative → the default. Exported for
 * tests.
 */
export function parseFreezeOcrRerunCap(raw: string | undefined | null): number {
  if (raw === undefined || raw === null) return DEFAULT_FREEZE_OCR_RERUN_CAP;
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_FREEZE_OCR_RERUN_CAP;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_FREEZE_OCR_RERUN_CAP;
  return parsed;
}

/**
 * Invalidate stored OCR whose execution-authority digest no longer matches
 * the freshly computed digest for the current member snapshot (P1-T3). The
 * stored copy is marked, never deleted: `packagingOcrData` / `packagingTitle`
 * stay intact so nothing is lost, while the persisted `ocrOutcome` becomes a
 * visible terminal failure marker (`status 'failed'`, reason
 * `'plan_incompatible'`, `stale: true`). The marker keeps the item visibly
 * unsettled (see `isOcrSettled`) until a fresh pull-forward under the new
 * authority binds fresh data + digest at the existing write site — or, past
 * the re-run cap, until a later pass picks it up.
 */
function invalidateStaleStoredOcr(item: OnboardingItem): OnboardingItem {
  const ext: Record<string, any> = { ...(item.extractionData ?? {}) };
  const priorOutcome = ext.ocrOutcome && typeof ext.ocrOutcome === 'object'
    ? ext.ocrOutcome as Record<string, any>
    : {};
  ext.ocrOutcome = {
    ...priorOutcome,
    status: 'failed',
    localFailureReason: 'plan_incompatible',
    stale: true,
  };
  updateItemExtractionData(item.id, JSON.stringify(ext));
  return { ...item, extractionData: ext as OnboardingItem['extractionData'] };
}

// ─── Execution-evidence projection (contract C) ───────────────────────────────

/**
 * Build the `execution-evidence-v3` projection for a cohort. Per member, one
 * entry (SORTED by onboardingItemId for deterministic hashing):
 * - `spreadsheetIdentity` — the frozen spreadsheet hints;
 * - `extraction` — the complete normalized extraction evidence the frozen-mode
 *   evidence stage may consume, including the OCR outcome/data, the
 *   `ocrInputHash` the OCR was started against, and the `ocrExecutionDigest`
 *   (execution-authority binding, Commit A) it was executed under;
 * - `evidenceHash` — `computeExtractionHash(item)` (member-local H2 input).
 *
 * Fails closed when a member has no extraction hash (the freeze gate requires
 * extraction completeness) or an attached PI import is incomplete (the
 * `piImportComplete: true` semantic assertion must be honest).
 */
export function buildExecutionEvidenceProjection(
  workspaceId: string,
  cohort: CurationCohort,
  members: CurationCohortMember[],
  items: OnboardingItem[],
  extractionSources: Map<string, ExtractionBinding>,
): ExecutionEvidenceProjectionV2 {
  // Legacy V2 builder retained for historical tests — delegates to V3 then downgrades
  const v3 = buildExecutionEvidenceProjectionV3(workspaceId, cohort, members, items, extractionSources);
  return {
    version: 'execution-evidence-v2',
    cohortId: v3.cohortId,
    batchId: v3.batchId,
    groupingVersion: v3.groupingVersion,
    members: v3.members.map(({ importedIdentity, version, ...rest }) => ({ ...rest, version: 'execution-evidence-v2' as const } as any)),
  };
}

export function buildExecutionEvidenceProjectionV3(
  workspaceId: string,
  cohort: CurationCohort,
  members: CurationCohortMember[],
  items: OnboardingItem[],
  extractionSources: Map<string, ExtractionBinding>,
): ExecutionEvidenceProjectionV3 {
  if (cohort.workspaceId !== workspaceId) {
    throw new Error(`Execution-evidence projection workspace mismatch: cohort belongs to ${cohort.workspaceId}, expected ${workspaceId}.`);
  }
  const itemsById = new Map(items.map(item => [item.id, item]));
  const sortedMembers = [...members].sort((a, b) => a.onboardingItemId.localeCompare(b.onboardingItemId));

  const memberEntries = sortedMembers.map(member => {
    const item = itemsById.get(member.onboardingItemId);
    if (!item) {
      throw new Error(`Execution-evidence projection: member item ${member.onboardingItemId} not found.`);
    }
    return buildExecutionEvidenceProjectionMember(member, item, extractionSources.get(item.id));
  });

  const projection: ExecutionEvidenceProjectionV3 = {
    version: 'execution-evidence-v3',
    cohortId: cohort.id,
    batchId: cohort.batchId,
    groupingVersion: cohort.groupingVersion,
    members: memberEntries,
  };
  const parsed = ExecutionEvidenceProjectionV3Schema.safeParse(projection);
  if (!parsed.success) {
    throw new Error(`Execution-evidence projection failed schema validation: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}

/**
 * Bounded extraction of the materializer's per-field merchandising provenance
 * (Amendment B). The v2 materializer writes
 * `distributorRecordProvenance.merchandisingProvenance` as a record of
 * field → [{ attemptId, providerId, catalogVersion, connectionId, values }].
 * Returns the frozen object only when it is a plain record of arrays of
 * bounded objects; anything else (missing, malformed, oversized) freezes as
 * {} — provenance is never invented at freeze time.
 */
function extractMerchandisingProvenance(ext: Record<string, any>): Record<string, Array<Record<string, unknown>>> | null {
  const prov =
    (ext as { distributorRecordProvenance?: { merchandisingProvenance?: unknown } | null })
      .distributorRecordProvenance?.merchandisingProvenance ?? null;
  if (prov == null || typeof prov !== 'object' || Array.isArray(prov)) return null;
  const result: Record<string, Array<Record<string, unknown>>> = {};
  for (const [field, entries] of Object.entries(prov)) {
    if (!Array.isArray(entries) || entries.length > 50) return null;
    const bounded: Array<Record<string, unknown>> = [];
    for (const entry of entries) {
      if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const e = entry as Record<string, unknown>;
      const values = Array.isArray(e.values) ? e.values.filter((v): v is string => typeof v === 'string' && v.length <= 500).slice(0, 50) : [];
      bounded.push({
        attemptId: typeof e.attemptId === 'string' ? e.attemptId.slice(0, 200) : '',
        providerId: typeof e.providerId === 'string' ? e.providerId.slice(0, 200) : '',
        catalogVersion: typeof e.catalogVersion === 'string' ? e.catalogVersion.slice(0, 200) : '',
        connectionId: typeof e.connectionId === 'string' ? e.connectionId.slice(0, 200) : '',
        values,
      });
    }
    result[field.slice(0, 100)] = bounded;
  }
  return result;
}

/**
 * Build ONE member's `execution-evidence-v1` entry from its live item — the
 * per-member core of `buildExecutionEvidenceProjection` (same fail-closed
 * extraction-completeness + PI-import-integrity gates). The freeze's per-member
 * loop uses this to build the member projection for the PR4 per-member
 * Product Type evidence directly from the post-OCR `frozenItem`; the final
 * CAS re-derives the identical entry from the reloaded item (verified against
 * the frozen hashes inside the transaction).
 */
function buildExecutionEvidenceProjectionMember(
  member: CurationCohortMember,
  item: OnboardingItem,
  binding: ExtractionBinding | undefined,
): ExecutionEvidenceProjectionMemberV3 {
  const ext: Record<string, any> = item.extractionData ?? {};

  const piEvidence = ((ext as { productIntelligenceEvidence?: Array<{ runId?: string; resultHash?: string; importRecordId?: string }> }).productIntelligenceEvidence ?? [])
    .map(entry => ({
      runId: String(entry.runId ?? ''),
      resultHash: String(entry.resultHash ?? ''),
      importRecordId: String(entry.importRecordId ?? ''),
    }))
    .filter(entry => entry.runId && entry.resultHash && entry.importRecordId)
    .sort((a, b) => a.runId.localeCompare(b.runId));
  const piImportComplete =
    ((ext as { productIntelligenceEvidence?: unknown[] }).productIntelligenceEvidence ?? []).length === 0 ||
    piEvidence.length === ((ext as { productIntelligenceEvidence?: unknown[] }).productIntelligenceEvidence ?? []).length;

  const evidenceHash = computeExtractionHash(item);
  if (!evidenceHash) {
    throw new Error(`Execution-evidence projection: member ${member.onboardingItemId} has no extraction hash (extraction evidence incomplete).`);
  }
  if (!piImportComplete) {
    throw new Error(`Execution-evidence projection: member ${member.onboardingItemId} has an incomplete Product Intelligence import (piImportComplete cannot be asserted).`);
  }

  // Amendment A provenance: item-level source, extraction binding provenance,
  // and the distributor identity fields (identity-only, never copy/commerce).
  const distributorProvenance =
    (ext as { distributorRecordProvenance?: { providerIds?: string[]; evidenceHash?: string } | null })
      .distributorRecordProvenance ?? null;
  const itemSourceType = item.sourceType ?? 'official_page';
  const extractionSourceType = binding?.sourceType ?? 'official_page';
  const extractionSourceUrl = binding?.sourceUrl ?? null;
  const acceptedEvidenceAttemptIds = Array.from(
    new Set([
      ...(binding?.acceptedEvidenceAttemptIds ?? []),
      ...(item.acceptedEvidenceAttemptIds ?? []),
    ]),
  ).sort();
  const acceptedProviderIds = Array.from(
    new Set(distributorProvenance?.providerIds ?? []),
  ).sort();

  // Milestone 5 — imported identity provenance (bounded, lossless, Zod-validated, canonical)
  let rawEnvelope: string | null = (item as any).rawIdentityJson ?? null;
  let normalizedEnvelope: string | null = (item as any).normalizedIdentityJson ?? null;
  let provenanceHash: string | null = (item as any).identityProvenanceHash ?? null;
  const version: number | null = (item as any).identityNormalizerVersion ?? null;
  // Validate envelopes are canonical JSON of their schemas; if not, fail closed to null (never accept arbitrary strings per cohorts.ts)
  try {
    const { RawIdentityEnvelopeV1Schema, NormalizedIdentityEnvelopeV1Schema } = require('./imported-identity');
    const { canonicalJsonStringify } = require('../shared/stable-id');
    if (rawEnvelope !== null) {
      const parsed = JSON.parse(rawEnvelope);
      const res = RawIdentityEnvelopeV1Schema.safeParse(parsed);
      if (!res.success || canonicalJsonStringify(parsed) !== rawEnvelope) rawEnvelope = null;
      else if (typeof provenanceHash === 'string' && !/^[a-f0-9]{64}$/.test(provenanceHash)) provenanceHash = null;
    }
    if (normalizedEnvelope !== null) {
      const parsed = JSON.parse(normalizedEnvelope);
      const res = NormalizedIdentityEnvelopeV1Schema.safeParse(parsed);
      if (!res.success || canonicalJsonStringify(parsed) !== normalizedEnvelope) normalizedEnvelope = null;
    }
  } catch { rawEnvelope = null; normalizedEnvelope = null; }
  const lossy = (item as any).identityLossy ?? (rawEnvelope === null && normalizedEnvelope !== null);
  const source = rawEnvelope === null && normalizedEnvelope !== null && version === 0 ? 'legacy_operational_backfill' as const : 'spreadsheet' as const;

  return ExecutionEvidenceProjectionV3Schema.shape.members.element.parse({
    version: 'execution-evidence-v3',
    onboardingItemId: item.id,
    ordinal: member.ordinal,
    productSku: item.upc ?? null,
    extractionComplete: true,
    sourceUrl: item.sourceUrl ?? null,
    extractionSourceUrl,
    sourcingDecision: item.sourcingDecision ?? null,
    itemSourceType,
    extractionSourceType,
    extractionMethod: binding?.extractionMethod ?? '',
    sourcingGenerationId: binding?.sourcingGenerationId ?? null,
    acceptedEvidenceAttemptIds,
    acceptedProviderIds,
    distributorEvidenceHash: binding?.evidenceHash ?? distributorProvenance?.evidenceHash ?? null,
    importedIdentity: {
      rawEnvelope,
      normalizedEnvelope,
      version,
      provenanceHash,
      lossy,
      source,
    },
    spreadsheetIdentity: {
      name: item.name,
      expectedName: item.expectedName ?? null,
      brandHint: item.brandHint ?? null,
      departmentHint: item.departmentHint ?? null,
      price: item.price ?? null,
      quantity: item.quantity ?? null,
      rowNumber: item.rowNumber,
      upc: item.upc ?? null,
    },
    extraction: {
      title: ext.title ?? null,
      description: ext.description ?? null,
      brand: ext.brand ?? null,
      weight: ext.weight ?? null,
      bulletPoints: Array.isArray(ext.bulletPoints) ? ext.bulletPoints : [],
      searchKeywords: ext.searchKeywords ?? null,
      primaryImage: ext.primaryImage ?? null,
      additionalImages: Array.isArray(ext.additionalImages) ? ext.additionalImages : [],
      customFields: ext.customFields ?? {},
      fieldProvenance: ext.fieldProvenance ?? {},
      manualEvidenceAttestationId: (ext as { manualEvidenceAttestationId?: string | null }).manualEvidenceAttestationId ?? null,
      manualReferenceUrl: (ext as { manualReferenceUrl?: string | null }).manualReferenceUrl ?? null,
      packagingTitle: ext.packagingTitle ?? null,
      distributorSku: ext.distributorSku ?? null,
      /** All accepted attempts' per-distributor reference values (sorted-unique). */
      distributorReferenceValues: ext.distributorReferenceValues ?? {},
      manufacturerPartNumber: ext.manufacturerPartNumber ?? null,
      variantAttributes: ext.variantAttributes ?? {},
      // Amendment B merchandising fields (M5b-1): frozen explicitly so
      // Curation/classification can consume verified v2 data without reading
      // live values. Defaults keep pre-merchandising v2 snapshots parseable.
      distributorCategory: ext.distributorCategory ?? null,
      dimensions: ext.dimensions ?? null,
      casePack: ext.casePack ?? null,
      unitOfMeasure: ext.unitOfMeasure ?? null,
      ingredients: ext.ingredients ?? null,
      merchandisingProvenance: extractMerchandisingProvenance(ext) ?? {},
      ocr: {
        outcome: ext.ocrOutcome ?? null,
        packagingOcrData: ext.packagingOcrData ?? null,
        ocrInputHash: computeOcrInputHash(item, extractionSourceUrl),
        ocrExecutionDigest: storedOcrExecutionDigest(item),
      },
      piEvidence,
      piImportComplete,
    },
    evidenceHash,
  });
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
  let localFailureReason: import('../shared/schemas/onboarding').OcrFailureReason | null = null;
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
      const { extractPackagingOcrFromCloud } = await import('./cloud-vlm-client');
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

/**
 * True when a child classification run accumulated model-call or stage side
 * effects (PR3 hardening, Commit A / R4). A running child with side effects
 * under a DIFFERENT snapshot authority is retired (never rebound); a
 * side-effect-free child is re-linked to the new snapshot in place.
 */
function childRunHasSideEffects(childRunId: string): boolean {
  const db = getDb();
  const call = db.query('SELECT 1 FROM classification_model_calls WHERE run_id = ? LIMIT 1').get(childRunId);
  if (call) return true;
  const stage = db.query('SELECT 1 FROM classification_stage_results WHERE run_id = ? LIMIT 1').get(childRunId);
  return Boolean(stage);
}

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
        getDb().run(
          'UPDATE classification_runs SET config_snapshot_id = ?, config_snapshot_hash = ? WHERE id = ?',
          [runtimeSnapId, runtimeSnapHash, memberRun.id],
        );
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

// ─── verifyFrozen implementation for reclaim (contract A, D5) ─────────────────

/**
 * Production `verifyFrozen` verdict for lease reclaim. True ('match') when the
 * run may be resumed:
 * - a `freezing` run with NULL frozen hashes is a crash mid-freeze → vacuous
 *   match ONLY while the run is still actively reclaimable (`status ===
 *   'freezing'`). A cancelled/failed/superseded NULL-hash run is NOT a
 *   vacuous match — it must be superseded (retry / slot reopen), never
 *   resumed as if it were a live freeze;
 * - otherwise the CURRENT world must still match the frozen run: cohort ready +
 *   non-superseded, membership hash equal, the rebuilt execution-evidence
 *   projection hashes to `evidenceSnapshotHash`, and config/page/policy
 *   digests unchanged. Any throw or mismatch → 'drift' (supersede + new run).
 */
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

// ─── Prepared-cohort execution contract (amendment 6) ─────────────────────────

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
 * Build the frozen per-member execution view (PR3 hardening, Commit B / R2).
 *
 * Prepared mode CONSTRUCTS the executed member FROM the frozen projection — it
 * never overlays onto live semantic evidence. Identity fields (id, upc,
 * batchId, rowNumber, stage/status) are pipeline state and come from the live
 * item; every SEMANTIC field comes from the projection:
 * - `name`/`expectedName`/`brandHint`/`departmentHint`/`price`/`quantity`
 *   from `spreadsheetIdentity`;
 * - `sourceUrl` from the projection VERBATIM — an authoritative null STAYS
 *   null, never `?? item.sourceUrl`;
 * - `extractionData` constructed purely from projection fields (title/brand/
 *   description/weight/bulletPoints/searchKeywords/customFields/
 *   fieldProvenance/primaryImage/additionalImages/packagingTitle/ocr
 *   {outcome,packagingOcrData,ocrInputHash,ocrExecutionDigest}/piEvidence) —
 *   NO live `...ext` spread, so a post-freeze mutation of
 *   `extraction_data_json`/`source_url`/`name`/`brand_hint` is never visible.
 */

/** The frozen `extractionData` view for one member projection — shared by
 *  `buildFrozenItem` (live identity) and `frozenItemFromProjection` (synthetic
 *  sibling views). Constructed PURELY from projection fields. */
/**
 * Normalize a versioned frozen member to the V2 shape. Historical V1 members
 * normalize to official-page provenance (in-memory only — persisted V1 bytes
 * are never rewritten).
 */
function toV2Member(projection: ExecutionEvidenceProjectionMember): ExecutionEvidenceProjectionMemberV2 {
  if ('itemSourceType' in projection) {
    // V3 members include importedIdentity; strip it for V2 consumers
    const { importedIdentity, ...rest } = projection as any;
    return rest as ExecutionEvidenceProjectionMemberV2;
  }
  return normalizeExecutionEvidenceProjectionMemberV1(projection as ExecutionEvidenceProjectionMemberV1);
}

function toV3Member(projection: ExecutionEvidenceProjectionMember): ExecutionEvidenceProjectionMemberV3 {
  if ((projection as any).version === 'execution-evidence-v3') return projection as ExecutionEvidenceProjectionMemberV3;
  if ('itemSourceType' in projection) {
    return normalizeExecutionEvidenceProjectionMemberV2(projection as ExecutionEvidenceProjectionMemberV2);
  }
// @ts-ignore -- Milestone 5 V3 compat: V2 test fixtures remain byte-readable via parse adapter, new freezes use V3
  return normalizeExecutionEvidenceProjectionV1ToV3(projection as ExecutionEvidenceProjectionMemberV1);
}

function frozenExtractionData(
  projection: ExecutionEvidenceProjectionMember,
): OnboardingItem['extractionData'] {
  const member = toV2Member(projection);
  const frozen = member.extraction;
  return {
    title: frozen.title ?? null,
    brand: frozen.brand ?? null,
    description: frozen.description ?? null,
    weight: frozen.weight ?? null,
    bulletPoints: [...frozen.bulletPoints],
    searchKeywords: frozen.searchKeywords ?? null,
    primaryImage: frozen.primaryImage ?? null,
    additionalImages: [...frozen.additionalImages],
    customFields: { ...frozen.customFields },
    fieldProvenance: { ...frozen.fieldProvenance },
    packagingTitle: frozen.packagingTitle ?? null,
    distributorSku: frozen.distributorSku ?? null,
    distributorReferenceValues: { ...(frozen.distributorReferenceValues ?? {}) },
    manufacturerPartNumber: frozen.manufacturerPartNumber ?? null,
    variantAttributes: { ...frozen.variantAttributes },
    // Amendment B merchandising fields (M5b-1): reconstructed from the frozen
    // projection so Curation reads verified v2 values deterministically —
    // never live values, never rewritten snapshots. Price/inventory/commerce
    // images stay absent by construction.
    distributorCategory: frozen.distributorCategory ?? null,
    dimensions: frozen.dimensions ?? null,
    casePack: frozen.casePack ?? null,
    unitOfMeasure: frozen.unitOfMeasure ?? null,
    ingredients: frozen.ingredients ?? null,
    merchandisingProvenance: { ...(frozen.merchandisingProvenance ?? {}) },
    packagingOcrData: frozen.ocr.packagingOcrData ?? null,
    ocrOutcome: frozen.ocr.outcome ?? null,
    ocrInputHash: frozen.ocr.ocrInputHash,
    ocrExecutionDigest: frozen.ocr.ocrExecutionDigest ?? null,
    productIntelligenceEvidence: frozen.piEvidence.map(entry => ({
      runId: entry.runId,
      resultHash: entry.resultHash,
      importRecordId: entry.importRecordId,
    })),
    // Member-local evidence identity (H2) from the frozen projection — the
    // executed member's extraction view carries the same evidence identity
    // the execution contract is bound to.
    evidenceHash: projection.evidenceHash,
  } as unknown as OnboardingItem['extractionData'];
}

export function buildFrozenItem(
  projection: ExecutionEvidenceProjectionMember,
  liveItem: OnboardingItem,
): OnboardingItem {
  projection = toV2Member(projection);
  const member = toV2Member(projection);
  const spread = member.spreadsheetIdentity;
  // PR3 hardening C (4): the executed member is CONSTRUCTED — never assembled
  // by spreading the live item. (a) the permitted live identity/pipeline
  // fields below (pipeline state, not semantic evidence); (b) every SEMANTIC
  // field from the frozen projection: spreadsheet identity, authoritative
  // sourceUrl, sourcingDecision, source type, accepted provenance, and a
  // purely projection-built extraction view. Live semantic fields
  // (sourcingDecision, accepted attempt IDs, prior curation data, source
  // type) can never leak into the executed member.
  return {
    // (a) Live identity / pipeline state.
    id: liveItem.id,
    upc: liveItem.upc,
    batchId: liveItem.batchId,
    rowNumber: liveItem.rowNumber,
    stage: liveItem.stage,
    stageStatus: liveItem.stageStatus,
    status: 'curated',
    errorMessage: null,
    retryCount: 0,
    isDuplicate: false,
    existingSku: null,
    isHeld: liveItem.isHeld ?? false,
    heldReason: liveItem.heldReason ?? null,
    createdAt: liveItem.createdAt,
    updatedAt: liveItem.updatedAt,
    // (b) Projection semantics — NO live spread.
    name: spread.name,
    expectedName: spread.expectedName,
    brandHint: spread.brandHint,
    departmentHint: spread.departmentHint,
    price: spread.price,
    quantity: spread.quantity,
    // Authoritative null STAYS null — never fall back to a post-freeze live value.
    sourceUrl: member.sourceUrl,
    // Amendment A: source type + accepted provenance restored from the frozen
    // member — never hardcoded, never read live post-freeze.
    sourceType: member.itemSourceType,
    coordinatedTitle: null,
    acceptedEvidenceAttemptId: null,
    acceptedEvidenceAttemptIds: [...member.acceptedEvidenceAttemptIds],
    sourcingDecision: member.sourcingDecision,
    curationData: null,
    extractionData: frozenExtractionData(member),
  };
}

/** Minimal frozen `OnboardingItem` view for ONE member — identity from the
 *  projection (member item id, sku, ordinal) + spreadsheet identity + frozen
 *  extraction. Used ONLY as the frozen sibling input for title coordination
 *  (`coordinateCohortItemsOnce`); never persisted. */
function frozenItemFromProjection(
  projection: ExecutionEvidenceProjectionMember,
  batchId: string,
): OnboardingItem {
  const member = toV2Member(projection);
  const spread = member.spreadsheetIdentity;
  return {
    id: projection.onboardingItemId,
    batchId,
    upc: projection.productSku ?? '',
    name: spread.name,
    price: spread.price,
    quantity: spread.quantity,
    brandHint: spread.brandHint,
    departmentHint: spread.departmentHint,
    sourceUrl: member.sourceUrl,
    expectedName: spread.expectedName,
    sourceType: member.itemSourceType,
    acceptedEvidenceAttemptIds: [...member.acceptedEvidenceAttemptIds],
    acceptedEvidenceAttemptId: null,
    sourcingDecision: member.sourcingDecision,
    stage: 'curation',
    stageStatus: 'pending',
    isHeld: false,
    heldReason: null,
    status: 'curated',
    errorMessage: null,
    retryCount: 0,
    isDuplicate: false,
    existingSku: null,
    extractionData: frozenExtractionData(projection),
    curationData: null,
    rowNumber: spread.rowNumber,
    createdAt: '',
    updatedAt: '',
  };
}

/**
 * Frozen product-line sibling context (PR3 hardening, Commit B / R2).
 *
 * Derived ENTIRELY from the persisted cohort + the FULL frozen
 * execution-evidence projections — sibling skus/names/brands from
 * `spreadsheetIdentity`, webTitles from projection titles, ocrTitles from
 * projection OCR, descriptions from the projection. NO `listItemsByBatch` /
 * `determineProductGroup` live reads: a post-freeze mutation of a sibling's
 * `extraction_data_json`/`name`/`brand_hint` is never visible to title/page
 * coordination. `frozenBatchItems` are frozen `OnboardingItem` views (one per
 * member) consumed as the title-coordination input; `productLineItems` are the
 * frozen per-SKU snapshots consumed by cohort page coordination.
 */
export interface FrozenProductLineContext {
  productLineContext: {
    groupId: string;
    groupLabel: string;
    siblingNames: string[];
    siblingWebTitles: string[];
    siblingOcrTitles: string[];
    siblingSkus: string[];
  };
  productLineItems: ProductLineItemSnapshot[];
  frozenBatchItems: OnboardingItem[];
  /**
   * PR6 review fix (SHOULD-FIX 2): per-SKU ACTUAL frozen `groupByProductLine`
   * group sizes — the exact grouping the parent title op's coordinator uses.
   * A member whose group has <2 members is a TRUE singleton: never
   * coordinated, no output row, keeps the per-item materialization path.
   */
  memberGroupSizes: Map<string, number>;
}

export function buildFrozenProductLineContext(
  cohort: CurationCohort,
  members: CurationCohortMember[],
  projections: ExecutionEvidenceProjectionMember[],
): FrozenProductLineContext {
  const ordered = projections.map(toV2Member).sort((a, b) => a.ordinal - b.ordinal);
  const siblingNames: string[] = [];
  const siblingWebTitles: string[] = [];
  const siblingOcrTitles: string[] = [];
  const siblingSkus: string[] = [];
  const productLineItems: ProductLineItemSnapshot[] = [];
  const frozenBatchItems: OnboardingItem[] = [];

  for (const projection of ordered) {
    const name = projection.spreadsheetIdentity.name;
    const sku = projection.productSku ?? '';
    const ocr = projection.extraction.ocr.packagingOcrData;
    siblingNames.push(name);
    siblingWebTitles.push(projection.extraction.title ?? '');
    const ocrTitle = ocr?.productName?.trim() || projection.extraction.packagingTitle?.trim() || '';
    if (ocrTitle) siblingOcrTitles.push(ocrTitle);
    if (sku) siblingSkus.push(sku);
    productLineItems.push({
      sku,
      name,
      webTitle: projection.extraction.title ?? null,
      // PR3 hardening C (5): the frozen sibling brand comes from
      // spreadsheetIdentity (the trusted import hint) — never the
      // web-extracted brand.
      brand: projection.spreadsheetIdentity.brandHint ?? null,
      description: projection.extraction.description ?? '',
      species: ocr?.species ?? [],
      flavor: ocr?.flavorVariety ?? null,
      lifeStage: ocr?.lifeStage ?? null,
      productForm: ocr?.productForm ?? null,
      healthConcern: ocr?.healthConcernFunction ?? [],
    });
    frozenBatchItems.push(frozenItemFromProjection(projection, cohort.batchId));
  }

  // PR6 review fix (SHOULD-FIX 2): the member's ACTUAL frozen group size from
  // `groupByProductLine` over the frozen sibling views — the SAME grouping the
  // parent title op's coordinator uses for its completeness check. A mixed
  // cohort (>=2 SKUs) never forces a true singleton into the grouped path.
  const memberGroupSizes = new Map<string, number>();
  for (const groupItems of groupByProductLine(frozenBatchItems).values()) {
    for (const item of groupItems) {
      if (item.upc) memberGroupSizes.set(item.upc, groupItems.length);
    }
  }

  return {
    productLineContext: {
      groupId: cohort.groupKey,
      groupLabel: cohort.groupLabel,
      siblingNames,
      siblingWebTitles,
      siblingOcrTitles,
      siblingSkus,
    },
    productLineItems,
    frozenBatchItems,
    memberGroupSizes,
  };
}

// ─── Cohort execution (PR3 M3, contract D step 6) ─────────────────────────────

/** One member's execution outcome (recorded, never silently dropped). */
export interface CohortMemberExecutionResult {
  itemId: string;
  productSku: string | null;
  ok: boolean;
  error: string | null;
}

/** Parent completion summary returned by `processCohort`. */
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
 * Rebuild the prepared-cohort context for one member from the freeze-persisted
 * child run: the child run's `config_snapshot_*` refs point at the member's
 * frozen runtime snapshot (persisted by `freezeCohortForExecution`); the
 * shared authorities (config ref, verified Page catalog, frozen fieldOptions,
 * model-policy view) are read back from that immutable snapshot — never
 * re-captured live.
 */
function buildPreparedCohortContextForMember(
  parentRun: CohortRun,
  memberProjection: ExecutionEvidenceProjectionMember,
  childRun: ClassificationRunRow,
  workspaceId: string,
): PreparedCohortContext {
  memberProjection = toV2Member(memberProjection);
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
  // PR4 C4b: the cohort Execution Product Type is read from the parent run row
  // (written once at freeze inside the final CAS). Filled ONLY when the id is
  // non-null — flag OFF / abstained / conflicted runs leave it absent, so the
  // member pipeline never sees (or records) an execution-type context.
  const cohortExecutionType = parentRun.executionProductTypeId !== null
    ? {
        id: parentRun.executionProductTypeId,
        confidence: parentRun.productTypeConfidence,
        outcome: parentRun.productTypeOutcome,
      }
    : undefined;
  // PR5 (DECISION-H/J): resolve the member's effective Curation Product Type
  // ONCE here — reviewed facts from the member's frozen snapshot first, the
  // cohort Execution Product Type as fallback, else none. The stages
  // (`getEffectiveCurationProductType`) and the member-projection dependency
  // stamping read the SAME resolution, so they agree by construction.
  const resolvedEffectiveType = getEffectiveCurationTypeForSnapshot(
    memberSnapshot,
    parentRun.executionProductTypeId,
  );
  const effectiveType = {
    id: resolvedEffectiveType.effectiveTypeId,
    source: resolvedEffectiveType.source,
  };
  return {
    memberProjection: toV2Member(memberProjection),
    parentRunId: parentRun.id,
    memberSnapshotId: childRun.configSnapshotId,
    memberSnapshotHash: childRun.configSnapshotHash,
    sharedAuthorities: {
      configSnapshotRef: memberSnapshot.configSnapshotRef,
      pages: memberSnapshot.pages,
      pageImportId: memberSnapshot.pageImportId,
      pageImportHash: memberSnapshot.pageImportHash,
      fieldOptions: memberSnapshot.fieldOptions,
      focusedFileHashes: memberSnapshot.focusedFileHashes,
      catalogEvidenceHash: memberSnapshot.catalogEvidenceHash,
      modelPolicyView: memberSnapshot.modelPolicy
        ? modelPolicyViewFromConfig(memberSnapshot.modelPolicy as never, memberSnapshot.snapshotHash)
        : null,
    },
    cohortExecutionType,
    effectiveType,
  };
}

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
export async function processCohort(
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
// @ts-ignore -- Milestone 5 V3 compat: V2 test fixtures remain byte-readable via parse adapter, new freezes use V3
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
    coordinatedTitles = await ensureCohortTitlesCoordinated({
      run,
      workspaceId,
      workspacePath,
      projection,
      cohort,
      members,
      frozenLineContext,
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
    coordinatedPages = await ensureCohortPagesCoordinated({
      run,
      workspaceId,
      workspacePath,
      projection,
      cohort,
      members,
      frozenLineContext,
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
    const childRow = getDb().query(
      `SELECT id, status FROM classification_runs
       WHERE cohort_run_id = ? AND onboarding_item_id = ?
       ORDER BY started_at DESC LIMIT 1`,
    ).get(run.id, item.id) as { id: string; status: string } | undefined;
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
        // exact. With no prior refs, buildPreparedCohortContextForMember fails
        // closed below (deterministic member failure).
        const prior = getDb().query(
          `SELECT config_snapshot_id, config_snapshot_hash FROM classification_runs
           WHERE cohort_run_id = ? AND onboarding_item_id = ?
             AND config_snapshot_id IS NOT NULL AND config_snapshot_hash IS NOT NULL
           ORDER BY started_at DESC LIMIT 1`,
        ).get(run.id, item.id) as { config_snapshot_id: string; config_snapshot_hash: string } | undefined;
        if (prior) {
          getDb().run(
            'UPDATE classification_runs SET config_snapshot_id = ?, config_snapshot_hash = ? WHERE id = ?',
            [prior.config_snapshot_id, prior.config_snapshot_hash, childRun.id],
          );
          childRun.configSnapshotId = prior.config_snapshot_id;
          childRun.configSnapshotHash = prior.config_snapshot_hash;
        }
      }
      const prepared = buildPreparedCohortContextForMember(run, memberProjection, childRun, workspaceId);

      // Frozen sibling context (Commit B / R2) — attached from the
      // projection-derived line context, never from a live batch query.
      prepared.productLineContext = frozenLineContext.productLineContext;
      prepared.productLineItems = frozenLineContext.productLineItems;
      prepared.frozenBatchItems = frozenLineContext.frozenBatchItems;
      prepared.memberGroupSizes = frozenLineContext.memberGroupSizes;
      // PR6: the durable parent-run title outputs (attached for every member;
      // only multi-item group members have entries).
      prepared.coordinatedTitles = coordinatedTitles;
      // PR7: the durable parent-run page outputs (attached for every member —
      // the P-set covers groups AND singletons; empty map in DECISION-C
      // config-level absence). The `category_page_proposals` stage materializes
      // these with ZERO Page LLM calls.
      prepared.coordinatedPages = coordinatedPages;
      // PR7 review R2 (F3.3): expected-empty marker — when the parent page op
      // produced NO output rows (page target enabled but no verified pages),
      // the child stage abstains with the clean legacy reason instead of
      // warning about a missing parent output. The parent op's contract makes
      // the map empty IFF it chose expected-empty (a complete set always has a
      // row per member).
      prepared.pageCoordinationAbsent = coordinatedPages.size === 0;

      // Scoped ownership-guarded lease keeper around the long-awaited member
      // pipeline (PR3 hardening A2): the parent lease is renewed on a TTL/3
      // cadence WHILE the pipeline is in flight, the member pipeline's own
      // terminal child write is ownership-guarded via
      // `prepared.assertOwnershipHeld`, and the continuation re-asserts
      // ownership before EVERY processCohort write (curation_data_json, item
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
      // member executed against) — resolved once, reused by the semantic
      // validation AND the dependency-stamping universal-attribute skip below
      // (never a live config read).
      let memberSnapshotForSemantic: ReturnType<typeof getRuntimeSnapshotByHash> | undefined;
      try {
        prepared.assertOwnershipHeld = () => pipelineKeeper.assertHeld();
        const pipelinePromise = curateItemWithPipeline(item, workspacePath, workspaceId, prepared);
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
        // attached to the prepared context, the member's pipeline proposals,
        // and the frozen runtime snapshot attribute config (the SAME
        // immutable ref the member executed against — never a live config
        // read). The snapshot resolve fails the member closed on a missing
        // ref. Hard findings mark the member BLOCKED — NOT review-ready (the
        // review completion gate enforces it) — while curationData + proposals
        // stay intact for PR10's Review UX (blocked-not-destroyed). Soft
        // findings never block.
        memberSnapshotForSemantic = childRun.configSnapshotHash
          ? getRuntimeSnapshotByHash(workspaceId, childRun.configSnapshotHash)
          : undefined;
        if (!memberSnapshotForSemantic || !childRun.configSnapshotHash) {
          throw new Error(
            `processCohort: run ${run.id} member ${item.id} (SKU ${item.upc ?? 'n/a'}) frozen runtime snapshot ` +
            `${childRun.configSnapshotHash ?? 'null'} not found for semantic validation.`,
          );
        }
        // Test-only seam (PR9 review R1, T1): inject a persisted pipeline
        // proposal set IMMEDIATELY before semantic validation runs — the
        // validator consumes the in-memory curation data. Production callers
        // never pass it.
        hooks?.beforeSemanticValidation?.(curationData);
        const memberSkuForSemantic = item.upc ?? item.id;
        const executionTypeIdForSemantic = prepared.cohortExecutionType?.id ?? null;
        const executionTypeLabelForSemantic = executionTypeIdForSemantic
          ? memberSnapshotForSemantic.productTypes.find(candidate => candidate.id === executionTypeIdForSemantic)?.name ?? null
          : null;
        const effectiveTypeIdForSemantic = prepared.effectiveType?.id ?? null;
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
        const durableTitleOutputForSemantic =
          prepared.coordinatedTitles?.get(memberSkuForSemantic) ?? null;
        const durablePageOutputForSemantic =
          prepared.coordinatedPages?.get(memberSkuForSemantic)?.output ?? null;
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
          pageOutputExpectedEmpty: prepared.pageCoordinationAbsent === true,
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
      const memberSkuForCommit = item.upc ?? item.id;
      const durableTitleForCommit = prepared.coordinatedTitles?.get(memberSkuForCommit) ?? null;
      const familyTitleValidation =
        durableTitleForCommit &&
        (durableTitleForCommit.source === 'llm_cohort' || durableTitleForCommit.source === 'cohort_fallback')
          ? {
              version: FAMILY_TITLE_CONSISTENCY_VERSION,
              status: 'passed' as const,
              source: durableTitleForCommit.source,
            }
          : undefined;
      const durablePageOutputForCommit = prepared.coordinatedPages?.get(memberSkuForCommit)?.output ?? null;
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
      getDb().transaction(() => {
        updateItemCurationData(item.id, JSON.stringify(committedCurationData));
        updateItemStageStatus(item.id, 'completed');
        completeRun(childRun.id, childTerminalStatus);
        const execType = prepared.cohortExecutionType;
        const effectiveType = prepared.effectiveType;
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
          effectiveType?.source === 'execution' && effectiveType.id !== null && execType !== undefined;
        const reviewedDriven = effectiveType?.source === 'reviewed' && effectiveType.id !== null;
        if (executionDriven || reviewedDriven) {
          // `field_assignment` follows `effectiveType.source` EXACTLY as
          // today (unchanged PR5 behavior).
          const dependencyKind: 'execution_product_type' | 'reviewed_product_type' =
            executionDriven ? 'execution_product_type' : 'reviewed_product_type';
          const dependencyTargetId = effectiveType!.id!;
          const dependencyValueHash = executionDriven
            ? hashCanonicalJson({
                executionProductTypeId: dependencyTargetId,
                productTypeConfidence: execType!.confidence,
              })
            : hashCanonicalJson({ reviewedProductTypeId: dependencyTargetId });
          const fieldRows = getDb().query(
            'SELECT id, target_id FROM classification_proposals WHERE run_id = ? AND proposal_type = ?',
          ).all(childRun.id, 'field_assignment') as Array<{ id: string; target_id: string | null }>;
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
        if (execType !== undefined && execType.id !== null && prepared.coordinatedPages !== undefined) {
          const pageValueHash = hashCanonicalJson({
            executionProductTypeId: execType.id,
            productTypeConfidence: execType.confidence,
          });
          const pageRows = getDb().query(
            'SELECT id FROM classification_proposals WHERE run_id = ? AND proposal_type = ?',
          ).all(childRun.id, 'category_page') as Array<{ id: string }>;
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
        stage: 'curation',
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
        stage: 'curation',
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
    const firstCommittedChild = getDb().query(
      `SELECT config_snapshot_hash FROM classification_runs
       WHERE cohort_run_id = ? AND status IN ('completed', 'completed_with_abstentions')
       ORDER BY started_at ASC LIMIT 1`,
    ).get(run.id) as { config_snapshot_hash: string | null } | undefined;
    if (firstCommittedChild?.config_snapshot_hash) {
      const memberSnapshotForBrands = getRuntimeSnapshotByHash(
        workspaceId,
        firstCommittedChild.config_snapshot_hash,
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
          stage: 'curation',
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