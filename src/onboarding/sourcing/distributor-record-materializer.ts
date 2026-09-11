import { getDb } from '../../db/connection';
import { toCanonicalStage } from '../../shared/onboarding-stage-vocabulary';
import {
  findItemById,
  updateItemStageStatus,
} from '../../db/repositories/onboarding-item-repo';
import { findBatchById } from '../../db/repositories/onboarding-batch-repo';
import {
  getCurrentSourcingGeneration,
  getEvidenceAttemptsByItemAndGeneration,
} from '../../db/repositories/onboarding-evidence-repo';
import { getCurrentGenerationAcceptedAttemptIds } from '../../db/repositories/onboarding-acceptance-repo';
import { getStrategyCollectionResult } from '../../db/repositories/strategy-collection-result-repo';
import {
  usableContributions,
  type CollectionContribution,
} from './strategy-collection-result';
import { listResolvedConflictResolutions } from '../../db/repositories/onboarding-conflict-repo';
import {
  insertExtraction,
  findDistributorRecordExtraction,
} from '../../db/repositories/onboarding-extraction-repo';
import {
  buildDistributorRecordProjection,
  buildDistributorRecordProjectionV1,
  PROJECTION_VERSION,
  PROJECTION_VERSION_V2,
  type SourcingProjectionReasonCode,
  type DistributorRecordProjection,
  type DistributorRecordProjectionV2,
} from './distributor-record-projection';
import { normalizeWeightToLbs } from '../normalization/weight';

/**
 * Canonical structured weight for materialization (epic #46 follow-up,
 * operator rule): pounds, exactly two decimals — NEVER raw provider text.
 * The product name/title is NEVER normalized. Unparseable weights yield
 * null (the field is absent, not silently filled with a non-canonical
 * string); the raw value stays in the provider evidence for audit.
 */
export function canonicalMaterializedWeight(rawWeight: string | null): string | null {
  if (rawWeight === null || rawWeight === '') return rawWeight;
  return normalizeWeightToLbs(rawWeight);
}

/**
 * Legacy-format tolerance for the idempotency invariant (epic #46
 * follow-up): rows materialized BEFORE weight canonicalization stored the
 * raw provider string ("0.0600 lb"). They must still re-verify against the
 * canonical builder output ("0.06") — weight-only divergence is accepted
 * when the stored weight normalizes to the expected canonical pounds. All
 * other keys must match byte-for-byte. Exported for tests.
 */
export function payloadsEquivalentAfterWeightNormalization(
  stored: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  if (stored.weight === undefined || expected.weight === undefined) return false;
  if (stored.weight === expected.weight) return false; // identical payloads take the main equality path
  const normalized = normalizeWeightToLbs(String(stored.weight));
  if (normalized === null || normalized !== expected.weight) return false;
  const { weight: _storedWeight, ...storedRest } = stored;
  const { weight: _expectedWeight, ...expectedRest } = expected;
  return JSON.stringify(storedRest) === JSON.stringify(expectedRest);
}

/**
 * Normalize the one additive field introduced after distributor_record_v2
 * shipped. A historical v2 payload legitimately has no
 * distributorReferenceValues key; its absence is not tampering. The expected
 * freshly-built value is used for the compatibility projection so retries can
 * backfill the durable row and item payload deterministically.
 */
export function normalizeHistoricalDistributorRecordV2Payload(
  stored: Record<string, unknown>,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  if (
    !Object.prototype.hasOwnProperty.call(stored, 'distributorReferenceValues') &&
    Object.prototype.hasOwnProperty.call(expected, 'distributorReferenceValues')
  ) {
    // Rebuild in expected-key order so the existing byte-stable JSON
    // invariant remains meaningful after the additive field is backfilled.
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(expected)) {
      if (key === 'distributorReferenceValues') {
        normalized[key] = expected[key];
      } else if (Object.prototype.hasOwnProperty.call(stored, key)) {
        normalized[key] = stored[key];
      }
    }
    for (const key of Object.keys(stored)) {
      if (!Object.prototype.hasOwnProperty.call(normalized, key)) normalized[key] = stored[key];
    }
    return normalized;
  }
  return stored;
}

/** Compare a distributor payload with the additive v2 compatibility rule. */
export function payloadsEquivalentForDistributorRecord(
  stored: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  const normalizedStored = normalizeHistoricalDistributorRecordV2Payload(stored, expected);
  return (
    JSON.stringify(normalizedStored) === JSON.stringify(expected) ||
    payloadsEquivalentAfterWeightNormalization(normalizedStored, expected)
  );
}
import { normalizeGtin } from './contracts';
import { SourcingDecisionV2Schema } from '../../shared/schemas/onboarding';
import {
  EvidenceAttemptSchema,
  ProductIdentityEvidenceSchema,
  type EvidenceAttempt,
  type ProductIdentityEvidence,
} from '../../shared/schemas/distributor-evidence';

/**
 * Deterministic distributor-record extraction materializer (Amendment A,
 * Milestone D).
 *
 * `materializeDistributorRecordExtraction(itemId, workspaceId)` executes
 * entirely inside a single repository transaction and rechecks every
 * authority BEFORE writing:
 *
 * - the item is workspace-owned and `extraction/in_progress`;
 * - the current V2 decision is `distributor_record_to_extraction`;
 * - the decision's generation is exactly the current (non-superseded) one;
 * - relational accepted IDs exactly match the decision's accepted set;
 * - every accepted attempt is schema-valid, `found`, exact-identifier,
 *   same item/workspace/generation, and connection-owned;
 * - no current open hard identity conflict exists;
 * - the recomputed canonical projection/hash equals the decision hash.
 *
 * Integrity failures return a stable error code and perform NO partial
 * insert/update (the transaction never starts). Unchanged evidence can never
 * heal an integrity error, so a failed materialization is NOT blindly
 * retried. A retry of the SAME generation/hash after success is idempotent:
 * the existing row is reused, never duplicated.
 *
 * This module performs ZERO external calls: no page fetch, extractor profile
 * lookup, DOM tooling, OCR, VLM, LLM, or image processing.
 */

export const DISTRIBUTOR_MATERIALIZATION_ERROR_CODES = {
  not_owned: 'not_owned',
  wrong_stage: 'wrong_stage',
  wrong_decision: 'wrong_decision',
  /** The serialized decision authority is absent or malformed (Milestone D round-8). */
  malformed_decision: 'malformed_decision',
  /** Defense-in-depth: an unexpected materializer throw maps here (job-queue catch). */
  internal_error: 'internal_error',
  stale_generation: 'stale_generation',
  superseded_generation: 'superseded_generation',
  acceptance_mismatch: 'acceptance_mismatch',
  invalid_attempt: 'invalid_attempt',
  open_conflict: 'open_conflict',
  hash_mismatch: 'hash_mismatch',
  /** Amendment B (M5): a pre-deployment v1 decision cannot silently become a v2 materialization. */
  projection_version_mismatch: 'projection_version_mismatch',
  /** Amendment B (M5): an existing extraction row carries an unknown/absent method. */
  unknown_extraction_method: 'unknown_extraction_method',
  already_completed: 'already_completed',
  stored_payload_diverged: 'stored_payload_diverged',
} as const;
export type DistributorMaterializationErrorCode =
  (typeof DISTRIBUTOR_MATERIALIZATION_ERROR_CODES)[keyof typeof DISTRIBUTOR_MATERIALIZATION_ERROR_CODES];

export type DistributorMaterializationResult =
  | {
      ok: true;
      extractionId: string;
      idempotent: boolean;
      extractionData: Record<string, unknown>;
    }
  | {
      ok: false;
      code: DistributorMaterializationErrorCode;
      reasonCodes: SourcingProjectionReasonCode[];
    };

/** Deterministic helper: exact set equality (order-insensitive). */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((v) => setB.has(v));
}

/**
 * Amendment B (M5): recognized distributor-record extraction methods.
 */
export const DISTRIBUTOR_RECORD_EXTRACTION_METHODS = ['distributor_record_v1', 'distributor_record_v2'] as const;
export type DistributorRecordExtractionMethod = (typeof DISTRIBUTOR_RECORD_EXTRACTION_METHODS)[number];

/**
 * Build the identity-only ExtractionData v1 (Milestone D field map).
 * PURE and DETERMINISTIC — byte-for-byte the pre-Amendment-B payload (used
 * to verify existing v1 rows). Exported for the v1 idempotent-verification
 * path and tests.
 */
export function buildDistributorExtractionDataV1(
  p: DistributorRecordProjection,
  evidenceHash: string,
): Record<string, unknown> {
  return {
    title: p.name,
    brand: p.brand,
    description: null,
    bulletPoints: [],
    primaryImage: null,
    additionalImages: [],
    price: null,
    weight: canonicalMaterializedWeight(p.weight),
    dimensions: null,
    seoFileName: null,
    searchKeywords: null,
    sourceType: 'distributor_record',
    distributorProviderId: p.provenance.providerIds[0] ?? null,
    distributorEvidenceAttemptIds: p.provenance.acceptedAttemptIds,
    distributorProviderIds: p.provenance.providerIds,
    distributorSku: p.distributorSku,
    manufacturerPartNumber: p.manufacturerPartNumber,
    variantAttributes: {
      ...(p.size !== null ? { size: p.size } : {}),
      ...(p.count !== null ? { count: p.count } : {}),
      ...(p.packCount !== null ? { packCount: p.packCount } : {}),
      ...(p.flavor !== null ? { flavor: p.flavor } : {}),
      ...(p.formula !== null ? { formula: p.formula } : {}),
      ...p.customVariantAxes,
    },
    distributorRecordProvenance: {
      sourcingGenerationId: p.provenance.sourcingGenerationId,
      evidenceHash,
      acceptedEvidenceAttemptIds: p.provenance.acceptedAttemptIds,
      providerIds: p.provenance.providerIds,
      catalogVersions: p.provenance.catalogVersions,
    },
    sourceUrl: null,
    confidence: 0,
    fieldProvenance: Object.fromEntries(
      Object.entries(p.provenance.fieldProvenance).map(([field, entries]) => [
        field,
        entries[0]?.providerId ?? null,
      ]),
    ),
    packagingTitle: null,
    packagingOcrData: null,
    ocrOutcome: null,
    customFields: {},
  };
}

/**
 * Per-distributor reference values from the ACCEPTED evidence attempts
 * (Amendment B follow-up). Sorted-unique trimmed values per reference field
 * (`distributorSku`, `distributorUpc`, `name`). These fields are NOT
 * identity-critical — their disagreements never block qualification (the
 * projection consolidates the single pick) — but every accepted attempt's
 * value must reach Curation so no distributor data is lost. PURE and
 * DETERMINISTIC: only schema-valid `found` attempts in the accepted set
 * contribute; output keys and arrays are sorted.
 */
export function collectDistributorReferenceValues(
  acceptedAttemptIds: string[],
  attempts: EvidenceAttempt[],
): Record<string, string[]> {
  const accepted = new Set(acceptedAttemptIds);
  const byField = new Map<string, Set<string>>();
  for (const attempt of attempts) {
    if (attempt.outcome !== 'found' || !accepted.has(attempt.id) || !attempt.identityJson) continue;
    let identity: ProductIdentityEvidence;
    try {
      const parsed = ProductIdentityEvidenceSchema.safeParse(JSON.parse(attempt.identityJson) as unknown);
      if (!parsed.success) continue;
      identity = parsed.data;
    } catch {
      continue;
    }
    for (const field of ['distributorSku', 'distributorUpc', 'name'] as const) {
      const value = identity[field];
      if (typeof value === 'string' && value.trim()) {
        if (!byField.has(field)) byField.set(field, new Set());
        byField.get(field)!.add(value.trim());
      }
    }
  }
  const result: Record<string, string[]> = {};
  for (const field of Array.from(byField.keys()).sort()) {
    result[field] = Array.from(byField.get(field) ?? []).sort();
  }
  return result;
}

/**
 * Build the merchandising-depth ExtractionData v2 (Amendment B, M5). Adds
 * description, features (bulletPoints), explicit noncanonical category,
 * dimensions, case pack, unit of measure, ingredients, and APPROVED image
 * candidates with attempt/provider provenance. Price, commerce images,
 * OCR, URL, and arbitrary fields stay absent/null.
 *
 * Image approvals (Amendment B addendum 3, store-owner decision
 * 2026-08-15): the store owner explicitly opted in to using distributor
 * images as catalog assets (the authenticated distributor connection is the
 * supplier/manufacturer rights channel; every approval carries the exact
 * source attempts as evidence reference). Deterministic: approvals derive
 * from the projection's observedAt + accepted provenance, never from the
 * clock.
 * PURE and DETERMINISTIC: the fresh-insert path and the idempotent
 * re-validation path both use it, so a stored payload can be trusted only
 * when it deep-equals a freshly recomputed one.
 */
function buildDistributorExtractionDataV2(
  p: DistributorRecordProjectionV2,
  evidenceHash: string,
  attempts: EvidenceAttempt[],
): Record<string, unknown> {  const imageEntries = p.merchandisingProvenance['imageUrls'] ?? [];
  const distributorImageCandidates = p.imageUrls.map((url) => {
    const contributing = imageEntries.filter((e) => e.values.includes(url));
    return {
      url,
      sourceAttemptIds: Array.from(new Set(contributing.map((e) => e.attemptId))).sort(),
      // Schema-correct key (DistributorImageCandidateSchema): every candidate
      // carries both source attempt IDs and source provider IDs.
      sourceProviderIds: Array.from(new Set(contributing.map((e) => e.providerId))).sort(),
    };
  });
  return {
    title: p.name,
    brand: p.brand,
    description: p.description,
    bulletPoints: p.features,
    primaryImage: null,
    additionalImages: [],
    price: null,
    weight: canonicalMaterializedWeight(p.weight),
    dimensions: p.dimensions,
    seoFileName: null,
    searchKeywords: null,
    sourceType: 'distributor_record',
    distributorProviderId: p.provenance.providerIds[0] ?? null,
    distributorEvidenceAttemptIds: p.provenance.acceptedAttemptIds,
    distributorProviderIds: p.provenance.providerIds,
    distributorSku: p.distributorSku,
    manufacturerPartNumber: p.manufacturerPartNumber,
    distributorCategory: p.category,
    /**
     * All accepted attempts' values for per-distributor reference fields
     * (distributorSku, distributorUpc, name). The consolidated single pick
     * stays in `distributorSku`; this map preserves every value so
     * Curation/display never lose distributor data. Sorted-unique arrays.
     */
    distributorReferenceValues: collectDistributorReferenceValues(p.provenance.acceptedAttemptIds, attempts),
    casePack: p.casePack,
    unitOfMeasure: p.unitOfMeasure,
    ingredients: p.ingredients,
    distributorImageCandidates,
    distributorImageApprovals: distributorImageCandidates.map((c) => ({
      imageUrl: c.url,
      sourceAttemptIds: c.sourceAttemptIds,
      // Deterministic (projection provenance, never the clock).
      approvedAt: p.provenance.observedAt[0] ?? '',
      rightsAttested: true,
      approvalOrigin: 'distributor_channel_opt_in',
    })),
    variantAttributes: {
      ...(p.size !== null ? { size: p.size } : {}),
      ...(p.count !== null ? { count: p.count } : {}),
      ...(p.packCount !== null ? { packCount: p.packCount } : {}),
      ...(p.flavor !== null ? { flavor: p.flavor } : {}),
      ...(p.formula !== null ? { formula: p.formula } : {}),
      ...p.customVariantAxes,
    },
    distributorRecordProvenance: {
      sourcingGenerationId: p.provenance.sourcingGenerationId,
      evidenceHash,
      projectionVersion: p.version,
      extractionMethod: 'distributor_record_v2',
      acceptedEvidenceAttemptIds: p.provenance.acceptedAttemptIds,
      providerIds: p.provenance.providerIds,
      catalogVersions: p.provenance.catalogVersions,
      observedAt: p.provenance.observedAt,
      connectionIds: p.provenance.connectionIds,
      fieldProvenance: p.provenance.fieldProvenance,
      merchandisingProvenance: p.merchandisingProvenance,
    },
    sourceUrl: null,
    confidence: 0,
    fieldProvenance: Object.fromEntries(
      Object.entries(p.provenance.fieldProvenance).map(([field, entries]) => [
        field,
        entries[0]?.providerId ?? null,
      ]),
    ),
    packagingTitle: null,
    packagingOcrData: null,
    ocrOutcome: null,
    customFields: {},
  };
}

/**
 * Reconstruct the canonical distributor-record extraction payload for a
 * qualified projection + decision evidence hash (Amendment B, M5b-2).
 * Dispatches on the projection version: v2 merchandising-depth or v1
 * identity-only. Returns null for an unrecognized projection version so
 * promotion/readiness callers fail closed — a payload is never reconstructed
 * for an authority this module does not own.
 */
export function reconstructDistributorExtractionPayload(
  projection: DistributorRecordProjection | DistributorRecordProjectionV2,
  evidenceHash: string,
  attempts: EvidenceAttempt[],
): Record<string, unknown> | null {
  if (projection.version === PROJECTION_VERSION_V2) {
    return buildDistributorExtractionDataV2(projection as DistributorRecordProjectionV2, evidenceHash, attempts);
  }
  if (projection.version === PROJECTION_VERSION) {
    return buildDistributorExtractionDataV1(projection as DistributorRecordProjection, evidenceHash);
  }
  return null;
}

/**
 * Materialize the distributor-record extraction for one item.
 *
 * All rechecks and all writes happen inside ONE SQLite transaction. Any
 * integrity failure returns `{ ok: false, code }` BEFORE any write is
 * attempted — the caller marks the item `extraction/failed` with the stable
 * code (the materializer itself never performs a partial write).
 */
export function materializeDistributorRecordExtraction(
  itemId: string,
  workspaceId: string,
): DistributorMaterializationResult {
  const db = getDb();

  return db.transaction(() => {
    const item = findItemById(itemId);
    if (!item) {
      return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.not_owned, reasonCodes: [] };
    }
    if (item.sourceType !== 'distributor_record') {
      return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.wrong_decision, reasonCodes: [] };
    }
    // Slice 5b native: canonical stage check (dual read — either stored
    // spelling of the extraction stage qualifies while claimed).
    let canonicalStage: string;
    try {
      canonicalStage = toCanonicalStage(item.stage);
    } catch {
      return {
        ok: false as const,
        code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.wrong_stage,
        reasonCodes: [],
      };
    }
    if (canonicalStage !== 'collect_details' || item.stageStatus !== 'in_progress') {
      return {
        ok: false as const,
        code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.wrong_stage,
        reasonCodes: [],
      };
    }

    // Workspace ownership (fail closed; never materialize a foreign item).
    const batch = findBatchById(item.batchId);
    if (!batch || batch.workspaceId !== workspaceId) {
      return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.not_owned, reasonCodes: [] };
    }

    // The current V2 decision must be distributor_record_to_extraction.
    // Absent / malformed / schema-invalid decision authority fails closed
    // with the stable malformed_decision code (never throws — the row mapper
    // hydrates malformed JSON as null).
    if (item.sourcingDecision == null) {
      return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.malformed_decision, reasonCodes: [] };
    }
    const decisionParse = SourcingDecisionV2Schema.safeParse(item.sourcingDecision);
    if (!decisionParse.success) {
      return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.malformed_decision, reasonCodes: [] };
    }
    const decision = decisionParse.data;
    if (decision.route !== 'distributor_record_to_extraction') {
      return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.wrong_decision, reasonCodes: [] };
    }

    // The decision's generation must be exactly the CURRENT generation
    // (a superseded generation can never materialize).
    const generation = getCurrentSourcingGeneration(itemId);
    if (!generation || generation.id !== decision.sourcingGenerationId) {
      return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.stale_generation, reasonCodes: [] };
    }
    // A generation that is itself marked superseded (e.g. cancelled mid-run
    // without a successor) must never materialize — fail closed distinctly.
    if (generation.status === 'superseded') {
      return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.superseded_generation, reasonCodes: [] };
    }

    // Relational acceptances must exactly match the decision's accepted set.
    const acceptedIds = getCurrentGenerationAcceptedAttemptIds(itemId);
    if (!sameSet(acceptedIds, decision.acceptedEvidenceAttemptIds)) {
      return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.acceptance_mismatch, reasonCodes: [] };
    }

    // No current open hard conflict may exist.
    const openConflict = db
      .query(
        `SELECT 1 FROM onboarding_evidence_conflicts
         WHERE item_id = ? AND severity = 'hard' AND status = 'open'
           AND sourcing_generation_id IS (
             SELECT id FROM sourcing_generations
             WHERE item_id = ?
             ORDER BY rowid DESC LIMIT 1
           )
         LIMIT 1`,
      )
      .get(itemId, itemId);
    if (openConflict) {
      return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.open_conflict, reasonCodes: [] };
    }

    // Every accepted attempt must be schema-valid (full EvidenceAttemptSchema
    // recheck — the repo hydrates rows without validation), found,
    // exact-identifier, current-generation, and connection-owned in THIS
    // workspace. The projection recompute additionally enforces schema-valid
    // identity JSON.
    const attempts = getEvidenceAttemptsByItemAndGeneration(itemId, generation.id);
    const attemptsById = new Map(attempts.map((a) => [a.id, a]));
    const normalizedItemUpc = normalizeGtin(item.upc);
    for (const attemptId of decision.acceptedEvidenceAttemptIds) {
      const attempt = attemptsById.get(attemptId);
      if (!attempt) {
        return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.invalid_attempt, reasonCodes: [] };
      }
      if (!EvidenceAttemptSchema.safeParse(attempt).success) {
        return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.invalid_attempt, reasonCodes: [] };
      }
      if (attempt.outcome !== 'found') {
        return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.invalid_attempt, reasonCodes: [] };
      }
      if (normalizeGtin(attempt.lookupUpc) !== normalizedItemUpc) {
        return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.invalid_attempt, reasonCodes: [] };
      }
      if (!attempt.distributorConnectionId) {
        return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.invalid_attempt, reasonCodes: [] };
      }
      // Connection ownership: the attempt's connection must belong to the
      // ITEM's workspace (cross-workspace evidence can never materialize).
      const connection = db
        .query(
          `SELECT c.id FROM distributor_connections c
           WHERE c.id = ? AND c.workspace_id = ?`,
        )
        .get(attempt.distributorConnectionId, workspaceId) as { id: string } | undefined;
      if (!connection) {
        return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.invalid_attempt, reasonCodes: [] };
      }
    }

    // Recompute the canonical projection over the SAME inputs the decision
    // was made from — INCLUDING the item's persisted operator conflict
    // resolutions (candidate/custom/dismiss), which routing applied when it
    // produced the decision hash (final conflict resolution and the manual
    // use_distributor_record action both recompute with
    // `listResolvedConflictResolutions`). Omitting them here would make a
    // legitimate custom/candidate override fail with hash_mismatch. The hash
    // must match exactly (hash mismatch = the evidence or decision is not
    // what was qualified).
    const declaredVariantAxes = Array.from(
      new Set(
        attempts.flatMap((a) => (a.variantAxisDeclarations ?? []).map((d) => d.normalizedAxis)),
      ),
    );
    const projectionInput = {
      itemId,
      itemUpc: item.upc,
      sourcingGenerationId: generation.id,
      attempts,
      acceptedAttemptIds: decision.acceptedEvidenceAttemptIds,
      declaredVariantAxes,
      resolutions: listResolvedConflictResolutions(itemId),
    };

    // Amendment B (M5) authority dispatch: the DEFAULT authority is the v2
    // merchandising-depth projection. A decision whose hash was computed by
    // the pre-deployment v1 authority must NEVER silently become a v2
    // materialization (projection_version_mismatch — an explicit new
    // sourcing generation is required). Qualification logic is shared, so
    // both authorities qualify on exactly the same inputs; only the hash
    // (version + merchandising fields) differs.
    const projectionV2 = buildDistributorRecordProjection(projectionInput);
    if (!projectionV2.qualified) {
      return {
        ok: false as const,
        code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.hash_mismatch,
        reasonCodes: projectionV2.reasonCodes,
      };
    }
    const v2HashMatches = projectionV2.evidenceHash === decision.evidenceHash;
    const projectionV1 = buildDistributorRecordProjectionV1(projectionInput);
    const v1HashMatches = projectionV1.qualified && projectionV1.evidenceHash === decision.evidenceHash;

    // Idempotent retry: if ANY durable distributor-record extraction row
    // exists for this item, it must EXACTLY match the recomputed/decision
    // provenance — never insert a second (possibly divergent) row. The
    // finder locates by immutable identity (item + method) ONLY, so every
    // provenance column below is genuinely revalidated rather than being
    // tautologically re-read from a filtered lookup. The retried item must
    // still reach the completed state when everything matches (payload
    // restored + stage marked), otherwise it would remain claimable at
    // extraction/in_progress forever.
    const existing = findDistributorRecordExtraction(itemId);
    if (existing) {
      // Deterministic idempotency: the stored payload is a DERIVED artifact
      // and must STILL EQUAL a freshly recomputed one (materialization is
      // pure). A diverged payload means the row was altered outside the
      // materializer (e.g. a generic item-edit route) and must NEVER be
      // restored — fail closed with no restore, no completion, no partial
      // write. Dispatch by the EXISTING row's method: v2 rows re-verify with
      // the v2 authority, v1 rows with the v1 authority; an unknown/missing
      // method fails closed (unknown_extraction_method).
      const storedData = parseStoredExtractionData(existing.extraction_data_json);
      let expectedData: Record<string, unknown>;
      if (existing.extraction_method === 'distributor_record_v2') {
        if (!v2HashMatches) {
          return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.hash_mismatch, reasonCodes: [] };
        }
        expectedData = buildDistributorExtractionDataV2(projectionV2.projection, decision.evidenceHash, attempts);
      } else if (existing.extraction_method === 'distributor_record_v1') {
        if (!projectionV1.qualified || !v1HashMatches) {
          return { ok: false as const, code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.hash_mismatch, reasonCodes: [] };
        }
        expectedData = buildDistributorExtractionDataV1(projectionV1.projection, decision.evidenceHash);
      } else {
        return {
          ok: false as const,
          code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.unknown_extraction_method,
          reasonCodes: [],
        };
      }
      // The durable ROW's provenance columns are part of the shared
      // row/item/decision/projection invariant and must ALSO equal the
      // recomputed/decision values: source type, null URL, exact current
      // generation, decision-equal accepted attempt set, and the decision
      // hash. Any divergence fails closed (no restore, no completion, no
      // second insert).
      const rowAcceptedIds = parseStoredAcceptedIds(existing.accepted_evidence_attempt_ids_json);
      const rowDiverged =
        existing.source_type !== 'distributor_record' ||
        existing.source_url !== null ||
        existing.sourcing_generation_id !== generation.id ||
        existing.evidence_hash !== decision.evidenceHash ||
        !sameSet(rowAcceptedIds, decision.acceptedEvidenceAttemptIds) ||
        !payloadsEquivalentForDistributorRecord(storedData, expectedData);
      if (rowDiverged) {
        return {
          ok: false as const,
          code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.stored_payload_diverged,
          reasonCodes: [],
        };
      }
      const now = new Date().toISOString();
      // Re-emit the canonical payload when a historical v2 row was missing
      // distributorReferenceValues (or carried a legacy raw weight). This
      // upgrades both durable copies atomically while retaining idempotency.
      const restoredPayload = existing.extraction_method === 'distributor_record_v2'
        ? JSON.stringify(expectedData)
        : existing.extraction_data_json;
      db.query(
        'UPDATE onboarding_extractions SET extraction_data_json = ? WHERE id = ?',
      ).run(restoredPayload, existing.id);
      db.query(
        'UPDATE onboarding_items SET extraction_data_json = ?, updated_at = ? WHERE id = ?',
      ).run(restoredPayload, now, itemId);
      updateItemStageStatus(itemId, 'completed');
      return {
        ok: true as const,
        extractionId: existing.id,
        idempotent: true,
        extractionData: JSON.parse(restoredPayload) as Record<string, unknown>,
      };
    }

    // Fresh materialization: ONLY v2 decisions materialize. A pre-deployment
    // pending decision that matches only the v1 authority fails closed with
    // projection_version_mismatch (an explicit new sourcing generation is
    // required — merchandising is never silently added to a v1 decision).
    if (!v2HashMatches) {
      if (v1HashMatches) {
        return {
          ok: false as const,
          code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.projection_version_mismatch,
          reasonCodes: [],
        };
      }
      return {
        ok: false as const,
        code: DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.hash_mismatch,
        reasonCodes: [],
      };
    }

    // Materialize the merchandising-depth ExtractionData v2 from the
    // canonical projection (same deterministic builder used by the
    // idempotent path).
    const extractionData = buildDistributorExtractionDataV2(projectionV2.projection, decision.evidenceHash, attempts);
    const extractionDataJson = JSON.stringify(extractionData);
    const now = new Date().toISOString();

    const row = insertExtraction({
      itemId,
      sourceType: 'distributor_record',
      sourceUrl: null,
      extractionDataJson,
      extractionMethod: 'distributor_record_v2',
      confidence: 0,
      imagesJson: null,
      rawStructuredDataJson: JSON.stringify(extractionData.distributorRecordProvenance),
      sourcingGenerationId: generation.id,
      acceptedEvidenceAttemptIds: projectionV2.projection.provenance.acceptedAttemptIds,
      evidenceHash: decision.evidenceHash,
    });

    // Item payload + stage completion, atomically in the same transaction.
    db.query(
      'UPDATE onboarding_items SET extraction_data_json = ?, updated_at = ? WHERE id = ?',
    ).run(extractionDataJson, now, itemId);
    updateItemStageStatus(itemId, 'completed');

    return {
      ok: true as const,
      extractionId: row.id,
      idempotent: false,
      extractionData,
    };
  })();
}

/** Parse stored extraction JSON back for idempotent success (safe fallback). */
function parseStoredExtractionData(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Parse the durable row's accepted-attempt ids JSON column (null → empty). */
function parseStoredAcceptedIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

// ─── Ticket #122: strategy-collection materialization ───────────────────────

export const STRATEGY_COLLECTION_MATERIALIZATION_ERROR_CODES = {
  not_owned: 'not_owned',
  wrong_stage: 'wrong_stage',
  wrong_decision: 'wrong_decision',
  malformed_decision: 'malformed_decision',
  stale_generation: 'stale_generation',
  acceptance_mismatch: 'acceptance_mismatch',
  missing_envelope: 'missing_envelope',
  invalid_envelope: 'invalid_envelope',
  hash_mismatch: 'hash_mismatch',
  stored_payload_diverged: 'stored_payload_diverged',
} as const;
export type StrategyCollectionMaterializationErrorCode =
  (typeof STRATEGY_COLLECTION_MATERIALIZATION_ERROR_CODES)[keyof typeof STRATEGY_COLLECTION_MATERIALIZATION_ERROR_CODES];

export type StrategyCollectionMaterializationResult =
  | { ok: true; extractionId: string; idempotent: boolean; extractionData: Record<string, unknown> }
  | { ok: false; code: StrategyCollectionMaterializationErrorCode };

/** Merge keys consolidated from compatible contributions (first nonblank wins, deterministic order). */
const STRATEGY_MERGE_KEYS = ['name', 'description', 'brand', 'weight', 'distributorSku'] as const;

function consolidateStrategyFields(usable: CollectionContribution[]): {
  merged: Record<string, string>;
  attribution: Record<string, string>;
} {
  const merged: Record<string, string> = {};
  const attribution: Record<string, string> = {};
  const ordered = [...usable].sort((a, b) => (a.providerId < b.providerId ? -1 : 1));
  for (const key of STRATEGY_MERGE_KEYS) {
    for (const c of ordered) {
      const value = c.fields[key];
      if (typeof value === 'string' && value.trim() && !merged[key]) {
        merged[key] = value;
        attribution[key] = c.providerId;
      }
    }
  }
  return { merged, attribution };
}

/**
 * Materialize a `completed_strategy_collection` decision from its validated
 * envelope. All rechecks and all writes happen inside ONE transaction; any
 * integrity failure returns `{ ok: false, code }` before any write.
 *
 * - Usable contributions consolidate merchandising fields (attribution
 *   preserved per field; connector completion order never decides).
 * - Completed-empty (zero usable contributions) preserves safe IMPORTED
 *   evidence (spreadsheet name/brand hint) with explicit
 *   `importedEvidence` provenance — never a fabricated qualified record,
 *   never a fake URL.
 * - Zero external calls: no fetch/profile/OCR/model/image work.
 */
export function materializeStrategyCollectionExtraction(
  itemId: string,
  workspaceId: string,
): StrategyCollectionMaterializationResult {
  const db = getDb();

  return db.transaction(() => {
    const item = findItemById(itemId);
    if (!item) {
      return { ok: false as const, code: STRATEGY_COLLECTION_MATERIALIZATION_ERROR_CODES.not_owned };
    }
    if (item.sourceType !== 'distributor_record') {
      return { ok: false as const, code: STRATEGY_COLLECTION_MATERIALIZATION_ERROR_CODES.wrong_decision };
    }
    let canonicalStage: string;
    try {
      canonicalStage = toCanonicalStage(item.stage);
    } catch {
      return { ok: false as const, code: STRATEGY_COLLECTION_MATERIALIZATION_ERROR_CODES.wrong_stage };
    }
    if (canonicalStage !== 'collect_details' || item.stageStatus !== 'in_progress') {
      return { ok: false as const, code: STRATEGY_COLLECTION_MATERIALIZATION_ERROR_CODES.wrong_stage };
    }
    const batch = findBatchById(item.batchId);
    if (!batch || batch.workspaceId !== workspaceId) {
      return { ok: false as const, code: STRATEGY_COLLECTION_MATERIALIZATION_ERROR_CODES.not_owned };
    }
    if (item.sourcingDecision == null) {
      return { ok: false as const, code: STRATEGY_COLLECTION_MATERIALIZATION_ERROR_CODES.malformed_decision };
    }
    const decisionParse = SourcingDecisionV2Schema.safeParse(item.sourcingDecision);
    if (!decisionParse.success) {
      return { ok: false as const, code: STRATEGY_COLLECTION_MATERIALIZATION_ERROR_CODES.malformed_decision };
    }
    const decision = decisionParse.data;
    if (decision.route !== 'completed_strategy_collection') {
      return { ok: false as const, code: STRATEGY_COLLECTION_MATERIALIZATION_ERROR_CODES.wrong_decision };
    }
    const generation = getCurrentSourcingGeneration(itemId);
    if (!generation || generation.id !== decision.sourcingGenerationId) {
      return { ok: false as const, code: STRATEGY_COLLECTION_MATERIALIZATION_ERROR_CODES.stale_generation };
    }
    const acceptedIds = getCurrentGenerationAcceptedAttemptIds(itemId);
    if (!sameSet(acceptedIds, decision.acceptedEvidenceAttemptIds)) {
      return { ok: false as const, code: STRATEGY_COLLECTION_MATERIALIZATION_ERROR_CODES.acceptance_mismatch };
    }

    // Validated envelope authority (fails closed; legacy rows without an
    // envelope never reach this function — the caller dispatches those to
    // the legacy materializer).
    let envelope: { envelope: import('./strategy-collection-result').StrategyCollectionResult; hash: string };
    try {
      envelope = getStrategyCollectionResult(generation.id);
    } catch (err) {
      const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined;
      return {
        ok: false as const,
        code: code === 'missing_envelope'
          ? STRATEGY_COLLECTION_MATERIALIZATION_ERROR_CODES.missing_envelope
          : STRATEGY_COLLECTION_MATERIALIZATION_ERROR_CODES.invalid_envelope,
      };
    }
    if (decision.evidenceHash !== envelope.hash) {
      return { ok: false as const, code: STRATEGY_COLLECTION_MATERIALIZATION_ERROR_CODES.hash_mismatch };
    }

    const usable = usableContributions(envelope.envelope);
    const { merged, attribution } = consolidateStrategyFields(usable);
    // Safe imported evidence fills what no source supplied — attributed as
    // imported, never presented as a source extraction.
    const importedEvidence: Record<string, boolean> = {};
    const title = merged.name ?? item.name ?? null;
    if (!merged.name) importedEvidence.title = true;
    const brand = merged.brand ?? item.brandHint ?? null;
    if (!merged.brand) importedEvidence.brand = true;
    const description = merged.description ?? null;
    if (!merged.description) importedEvidence.description = true;
    const fieldProvenance: Record<string, string | null> = {};
    for (const key of STRATEGY_MERGE_KEYS) {
      const outKey = key === 'name' ? 'title' : key;
      fieldProvenance[outKey] = attribution[key] ?? (importedEvidence[outKey] ? 'imported_evidence' : null);
    }
    const providerIds = Array.from(new Set(envelope.envelope.contributions.map((c) => c.providerId))).sort();
    const outcome: 'completed' | 'exhausted' = usable.length > 0 ? 'completed' : 'exhausted';

    const extractionData: Record<string, unknown> = {
      title,
      brand,
      description,
      bulletPoints: [],
      primaryImage: null,
      additionalImages: [],
      price: null,
      weight: merged.weight ? canonicalMaterializedWeight(merged.weight) : null,
      dimensions: null,
      seoFileName: null,
      searchKeywords: null,
      sourceType: 'distributor_record',
      distributorProviderId: usable[0]?.providerId ?? null,
      distributorEvidenceAttemptIds: decision.acceptedEvidenceAttemptIds,
      distributorProviderIds: providerIds,
      distributorSku: merged.distributorSku ?? null,
      manufacturerPartNumber: null,
      variantAttributes: {},
      distributorRecordProvenance: {
        sourcingGenerationId: generation.id,
        evidenceHash: envelope.hash,
        acceptedEvidenceAttemptIds: decision.acceptedEvidenceAttemptIds,
        providerIds,
      },
      strategyCollectionProvenance: {
        sourcingGenerationId: generation.id,
        strategyRevision: envelope.envelope.strategyRevision,
        strategyBrand: envelope.envelope.strategyBrand,
        strategyCollectionHash: envelope.hash,
        outcome,
        acceptedEvidenceAttemptIds: decision.acceptedEvidenceAttemptIds,
        providerIds,
        contributionOutcomes: envelope.envelope.contributions.map((c) => ({
          providerId: c.providerId,
          kind: c.kind,
          outcome: c.outcome,
          reasonCode: c.reasonCode ?? null,
        })),
      },
      importedEvidence,
      sourceUrl: null,
      confidence: 0,
      fieldProvenance,
      packagingTitle: null,
      packagingOcrData: null,
      ocrOutcome: null,
      customFields: {},
    };
    const extractionDataJson = JSON.stringify(extractionData);
    const now = new Date().toISOString();

    // Idempotent retry: an existing strategy_collection_v1 row for the same
    // generation+hash is reused; a diverged row fails closed.
    const existing = db.query(
      `SELECT * FROM onboarding_extractions
       WHERE item_id = ? AND extraction_method = 'strategy_collection_v1'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(itemId) as
      | { id: string; sourcing_generation_id: string | null; evidence_hash: string | null; extraction_data_json: string }
      | undefined;
    if (existing) {
      if (
        existing.sourcing_generation_id !== generation.id ||
        existing.evidence_hash !== envelope.hash ||
        existing.extraction_data_json !== extractionDataJson
      ) {
        return { ok: false as const, code: STRATEGY_COLLECTION_MATERIALIZATION_ERROR_CODES.stored_payload_diverged };
      }
      db.query('UPDATE onboarding_items SET extraction_data_json = ?, updated_at = ? WHERE id = ?')
        .run(extractionDataJson, now, itemId);
      updateItemStageStatus(itemId, 'completed');
      return { ok: true as const, extractionId: existing.id, idempotent: true, extractionData };
    }

    const row = insertExtraction({
      itemId,
      sourceType: 'distributor_record',
      sourceUrl: null,
      extractionDataJson,
      extractionMethod: 'strategy_collection_v1',
      confidence: 0,
      imagesJson: null,
      rawStructuredDataJson: JSON.stringify(extractionData.strategyCollectionProvenance),
      sourcingGenerationId: generation.id,
      acceptedEvidenceAttemptIds: decision.acceptedEvidenceAttemptIds,
      evidenceHash: envelope.hash,
    });
    db.query('UPDATE onboarding_items SET extraction_data_json = ?, updated_at = ? WHERE id = ?')
      .run(extractionDataJson, now, itemId);
    updateItemStageStatus(itemId, 'completed');
    return { ok: true as const, extractionId: row.id, idempotent: false, extractionData };
  })();
}
