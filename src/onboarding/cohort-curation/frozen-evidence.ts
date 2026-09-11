/**
 * Frozen evidence — projection construction + frozen member views (Slice 1).
 *
 * The execution-window data every later step consumes WITHOUT re-reading
 * live state: `execution-evidence-v3` projection construction (contract C),
 * historical in-memory adapters, OCR input-hash/authority helpers,
 * `buildFrozenItem`, frozen sibling/group views, and the immutable
 * `FrozenProductLineContext`. No mutable catalog reads during member
 * execution (the single `updateItemExtractionData` write in
 * `invalidateStaleStoredOcr` is freeze-loop wiring, relocated here with the
 * OCR helpers; it moves with the loop into the execution package in Slice 2).
 *
 * Relocated verbatim from `src/onboarding/cohort-curator.ts` (Slice 1);
 * that module re-exports every moved symbol as a temporary forwarder
 * (deleted in Slice 6). Projection bytes, hash inputs, and the frozen-item
 * allowlist are unchanged.
 */
import { hashCanonicalJson } from '../../shared/stable-id';
import { computeExtractionHash } from '../../db/repositories/curation-cohort-repo';
import { updateItemExtractionData } from '../../db/repositories/onboarding-item-repo';
import type { ExtractionBinding } from '../../db/repositories/onboarding-extraction-repo';
import {
  ExecutionEvidenceProjectionV3Schema,
  normalizeExecutionEvidenceProjectionMemberV1,
  normalizeExecutionEvidenceProjectionMemberV2,
  normalizeExecutionEvidenceProjectionV1ToV3,
} from '../../shared/schemas/cohorts';
import type {
  CurationCohort,
  CurationCohortMember,
  ExecutionEvidenceProjectionMemberV2,
  ExecutionEvidenceProjectionMemberV3,
  ExecutionEvidenceProjectionMemberV1,
  ExecutionEvidenceProjectionMember,
  ExecutionEvidenceProjectionV2,
  ExecutionEvidenceProjectionV3,
} from '../../shared/schemas/cohorts';
import type {
  OnboardingItem,
  PackagingOcrData,
} from '../../shared/schemas/onboarding';
import type { ProductLineItemSnapshot } from '../../classification/types';
import type { PageSnapshotState } from '../../classification/runtime-snapshot';
import { groupByProductLine } from '../cohort-name-coordinator';

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
export function storedOcrInputHash(item: OnboardingItem): string | null {
  const ext = item.extractionData as { ocrInputHash?: unknown } | null | undefined;
  return ext && typeof ext.ocrInputHash === 'string' ? ext.ocrInputHash : null;
}

/** The ocrExecutionDigest recorded with the item's stored OCR (top-level
 *  marker in extraction_data_json, alongside ocrInputHash), or null when the
 *  stored OCR predates the execution-authority binding (unknown authority ⇒
 *  the reuse guard fails closed — Commit A2: reuse requires BOTH the stored
 *  and the current digest to be non-null and equal). */
export function storedOcrExecutionDigest(item: OnboardingItem): string | null {
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
export function isOcrSettled(item: OnboardingItem): boolean {
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
  'packagingType', 'npkRatio',
] as const;

/** Array OCR fields whose non-empty presence counts as usable content. */
const OCR_CONTENT_ARRAY_FIELDS = [
  'species', 'healthConcernFunction', 'dietaryLabels',
  'ingredients', 'ingredientKeywords', 'claims', 'visibleTextLines',
] as const;

/** True when a parsed OCR result carries usable content (same rule as the
 *  evidence extractor). */
export function hasOcrContent(ocr: PackagingOcrData | undefined | null): boolean {
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
export function invalidateStaleStoredOcr(item: OnboardingItem): OnboardingItem {
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
export function buildExecutionEvidenceProjectionMember(
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
    const { RawIdentityEnvelopeV1Schema, NormalizedIdentityEnvelopeV1Schema } = require('../imported-identity');
    const { canonicalJsonStringify } = require('../../shared/stable-id');
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

  // Ticket #124: freeze an open gap's recorded correction envelope into
  // the member (attributed overlay for execution). Absent unless a
  // recorded/preparing envelope exists — omission keeps historical bytes
  // and hashes identical. The envelope row is immutable; the frozen copy
  // participates in the projection hash, so post-freeze corrections can
  // never reuse this frozen decision.
  let correctionOverlay: { correctionHash: string; revision: number; actor: string; values: Record<string, string> } | undefined;
  try {
    const { getPreparationGap } = require('../../db/repositories/preparation-gap-repo') as typeof import('../../db/repositories/preparation-gap-repo');
    const gap = getPreparationGap(item.id);
    const envelope = gap?.status === 'open' ? gap.correctionEnvelope : null;
    if (envelope && (envelope.status === 'recorded' || envelope.status === 'preparing')) {
      correctionOverlay = {
        correctionHash: envelope.correctionHash,
        revision: envelope.revision,
        actor: envelope.actor,
        values: envelope.values,
      };
    }
  } catch {
    correctionOverlay = undefined;
  }

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
    ...(correctionOverlay ? { correctionOverlay } : {}),
  });
}

// ─── Frozen member views ─────────────────────────────────────────────────────

/**
 * Normalize a versioned frozen member to the V2 shape. Historical V1 members
 * normalize to official-page provenance (in-memory only — persisted V1 bytes
 * are never rewritten). Exported for the transitional prepared-member path
 * in `cohort-curator.ts` (moves into the execution package in Slice 5).
 */
export function toV2Member(projection: ExecutionEvidenceProjectionMember): ExecutionEvidenceProjectionMemberV2 {
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
    stage: 'prepare_listing',
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

// ─── Prepared-member product-line group (Slice 5) ───────────────────────────

export interface PreparedProductLineGroup {
  groupId: string;
  groupLabel: string;
  siblingNames: string[];
  siblingWebTitles: string[];
  siblingOcrTitles: string[];
  siblingSkus: string[];
}

/**
 * Assemble one member's frozen product-line group for prepared execution
 * (moved verbatim out of the shared curation body in Slice 5 so cohort
 * input construction happens before the pipeline seam).
 *
 * PR6 review fix (SHOULD-FIX 2): gates on the member's ACTUAL frozen
 * `groupByProductLine` group size (the exact grouping the parent title op's
 * coordinator uses) — never the all-cohort sibling count. A true singleton
 * (size 1) keeps the unchanged per-item `name_consolidation` path.
 * Hand-built contexts that omit `memberGroupSizes` fall back to the
 * all-cohort sibling count (uniform cohorts only).
 */
export function buildPreparedProductLineGroup(args: {
  productLineContext: FrozenProductLineContext['productLineContext'] | undefined;
  memberGroupSizes: Map<string, number> | undefined;
  memberUpc: string | null;
}): PreparedProductLineGroup | null {
  const { productLineContext, memberGroupSizes, memberUpc } = args;
  const memberGroupSize =
    (memberUpc !== null ? memberGroupSizes?.get(memberUpc) : undefined) ??
    (productLineContext?.siblingSkus.length ?? 0);
  if (productLineContext && memberGroupSize >= 2) {
    console.log(
      `[ProductCurator] Using frozen sibling context for ${memberUpc}: group "${productLineContext.groupId}"`,
    );
    return {
      groupId: productLineContext.groupId,
      groupLabel: productLineContext.groupLabel,
      siblingNames: productLineContext.siblingNames,
      siblingWebTitles: productLineContext.siblingWebTitles,
      siblingOcrTitles: productLineContext.siblingOcrTitles,
      siblingSkus: productLineContext.siblingSkus,
    };
  }
  return null;
}

/**
 * Resolve the verified Page identity set for prepared execution from the
 * freeze-persisted snapshot authority (moved verbatim out of the shared
 * curation body in Slice 5). Only identities verified in the FROZEN snapshot
 * are suggestions — the mutable page_index is never re-read after capture.
 */
export function verifiedPageIdsFromSnapshotAuthority(args: {
  pageImportId: string | null;
  pages: PageSnapshotState;
}): string[] {
  const { pageImportId, pages } = args;
  return pageImportId && pages.state === 'verified'
    ? pages.records.filter(r => r.verified).map(r => r.pageId)
    : [];
}
