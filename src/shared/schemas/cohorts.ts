// fallow-ignore-file unused-export

/**
 * Cohort-centric, type-first Curation (issue #30) — shared contracts.
 *
 * Durable product families: a `curation_cohort` is a versioned candidate
 * family of onboarding items grouped by a deterministic grouping algorithm.
 * Members are linked through `curation_cohort_members`. This file defines the
 * status/scoping vocabulary, row shapes, and API DTOs used across the DB
 * repository, the curation-cohort service, the onboarding worker, the API
 * route, and the Pipeline Board UI.
 */

import { z } from 'zod';
import {
  SourcingDecisionSchema,
  SourcingDecisionReadSchema,
  OcrAttemptOutcomeSchema,
  PackagingOcrDataSchema,
  SourceTypeEnum,
} from './onboarding';

// ─── Cohort Status ─────────────────────────────────────────────────────────────

/**
 * Lifecycle status of a curation cohort (schema v3, issue #31 commit 3 / D7).
 *
 * - `forming`: candidate family created by the grouping algorithm; members are
 *   still being evaluated for extraction completeness.
 * - `waiting`: at least one member's evidence is not yet stable (the derived
 *   "Waiting for N family members to finish Extraction" state).
 * - `ready`: every member's extraction evidence is complete and frozen into an
 *   extraction hash; the cohort is a stable candidate (PR3+ will execute it).
 * - `superseded`: a newer cohort revision replaced this row. Historical rows
 *   are superseded, never mutated in place.
 *
 * The cohort row is a candidate-family record ONLY: execution/lifecycle
 * states (`running`/`completed`/`failed`/`conflicted`) never belong on it —
 * cohort RUN state is owned by the cohort run (PR3+). The v3 migration narrows
 * the DB CHECK to these four values and deterministically maps any legacy
 * execution status to `ready`.
 */
/**
 * Cohort status. The operator-facing "candidate" statuses are
 * forming/waiting/ready, with superseded for replaced groupings — execution
 * states (running/completed/failed/conflicted) deliberately live on cohort
 * RUNS, not candidate rows (issue #31 F3 / v7). All-failed families are
 * superseded (terminal) rather than waiting forever (epic #46 follow-up).
 */
export const CohortStatusEnum = z.enum([
  'forming',
  'waiting',
  'ready',
  'superseded',
]);

export type CohortStatus = z.infer<typeof CohortStatusEnum>;

// ─── Readiness State ───────────────────────────────────────────────────────────

/**
 * Derived extraction-readiness state for a cohort member and its cohort
 * (issue #30 round-2 F5):
 *
 * - `ready`: every extraction-completeness condition is met;
 * - `waiting`: still processing — evidence is not yet complete;
 * - `blocked`: a member failed in Discovery/Extraction/Curation. This is a
 *   deterministic stop (never a wait) and carries a deterministic
 *   `Member failed (SKU: …)` reason.
 */
export const ReadinessStateSchema = z.enum(['ready', 'waiting', 'blocked']);

export type ReadinessState = z.infer<typeof ReadinessStateSchema>;

// ─── Curation Target Scopes ────────────────────────────────────────────────────

/**
 * The semantic scope of a curation target (issue #30, "Curation target scopes").
 *
 * - `family_invariant`: expected to resolve identically across finalized cohort
 *   members (e.g. canonical Brand, Primary Product Type). Disagreement is a
 *   semantic/evidence conflict — never normalized away.
 * - `coordinated_variant`: computed once using the full cohort, but individual
 *   member answers may legitimately differ (e.g. curated title, Category Page
 *   assignment).
 * - `member_local`: computed from the member's own evidence after cohort
 *   context is frozen (e.g. flavor, size, weight, color, life stage).
 */
export const CurationTargetScopeEnum = z.enum([
  'family_invariant',
  'coordinated_variant',
  'member_local',
]);

export type CurationTargetScope = z.infer<typeof CurationTargetScopeEnum>;

/**
 * Row shape of a persisted content-addressed execution-evidence snapshot
 * (`classification_cohort_snapshots`, issue #30 PR3 M2). `snapshotHash` is the
 * canonical digest (H2) over `payloadJson`; `UNIQUE(workspace_id,
 * snapshot_hash)` dedupes identical payloads to the same row. The run row
 * references the snapshot via `evidence_snapshot_id`.
 */
export const CohortSnapshotSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  /** H2 digest over the projection payload (content-addressed). */
  snapshotHash: z.string(),
  /** 'evidence' only (schema CHECK). */
  snapshotKind: z.literal('evidence'),
  /** 'execution-evidence-v1' — the versioned projection schema. */
  projectionVersion: z.string(),
  /** The versioned execution-evidence projection (canonical JSON). */
  payloadJson: z.string(),
  createdAt: z.string(),
});

export type CohortSnapshot = z.infer<typeof CohortSnapshotSchema>;

// ─── Frozen Execution-Evidence Projection (PR3 M2, contract C) ─────────────────

/**
 * Version of the frozen per-member execution-evidence projection. The
 * projection is what a cohort member's classification run is executed
 * against: the member evidence hash (`evidenceHash`), the input identity the
 * packaging OCR attempt was started against (`ocrInputHash`), and the
 * spreadsheet + normalized extraction fields the frozen-mode evidence stage
 * consumes — WITHOUT any live `onboarding_items` reads.
 */
export const PROJECTION_VERSION = 'execution-evidence-v1';

/**
 * Amendment A (default-on): source-aware execution-evidence projection.
 * `execution-evidence-v2` extends the V1 member with item/extraction source
 * provenance (item source type + nullable URL, extraction source type/URL/
 * method, sourcing generation, sorted accepted attempt/provider ids,
 * distributor evidence hash) and the distributor identity fields (SKU, MPN,
 * variant attributes). Written by cohort freezes; V1 snapshots stay
 * parse-only and normalize to official-page provenance through
 * `parseExecutionEvidenceProjection`.
 */
export const PROJECTION_VERSION_V2 = 'execution-evidence-v2';

/**
 * Per-member projection entry (`execution-evidence-v1`). Every member of a
 * frozen cohort contributes exactly one entry, sorted by `onboardingItemId`.
 * `extractionComplete` is the semantic assertion that extraction evidence is
 * complete — deliberately NOT raw stage/status (stage transitions are
 * irrelevant to the frozen evidence). `evidenceHash` is the member-local H2
 * input (`computeExtractionHash`); the cohort-level snapshot hash is the
 * digest over the whole projection.
 */
export const ExecutionEvidenceProjectionMemberSchema = z.object({
  onboardingItemId: z.string(),
  ordinal: z.number().int(),
  productSku: z.string().nullable(),
  /** Semantic assertion: extraction evidence is complete (never raw stage/status). */
  extractionComplete: z.literal(true),
  sourceUrl: z.string().nullable(),
  /** Latest onboarding_extractions.source_url (round-3 R4 provenance binding). */
  extractionSourceUrl: z.string().nullable(),
  sourcingDecision: SourcingDecisionSchema.nullable(),
  spreadsheetIdentity: z.object({
    name: z.string(),
    expectedName: z.string().nullable(),
    brandHint: z.string().nullable(),
    departmentHint: z.string().nullable(),
    price: z.string().nullable(),
    quantity: z.number().int().nullable(),
    rowNumber: z.number().int(),
    upc: z.string().nullable(),
  }),
  extraction: z.object({
    title: z.string().nullable(),
    description: z.string().nullable(),
    brand: z.string().nullable(),
    weight: z.string().nullable(),
    bulletPoints: z.array(z.string()),
    searchKeywords: z.string().nullable(),
    primaryImage: z.string().nullable(),
    additionalImages: z.array(z.string()),
    customFields: z.record(z.string(), z.string()),
    fieldProvenance: z.record(z.string(), z.string()),
    /**
     * Parent #101 (manual-evidence route): attestation link + reference-only
     * family URL for operator manual-evidence members. Null for automated
     * members; defaults keep pre-manual snapshots parseable.
     */
    manualEvidenceAttestationId: z.string().nullable().default(null),
    manualReferenceUrl: z.string().nullable().default(null),
    packagingTitle: z.string().nullable(),
    ocr: z.object({
      /** Terminal OCR outcome used by the frozen evidence (may be null when no attempt settled). */
      outcome: OcrAttemptOutcomeSchema.nullable(),
      packagingOcrData: PackagingOcrDataSchema.nullable(),
      /** SHA-256 over the canonical {sourceUrl, extractionSourceUrl, primaryImage, additionalImages} set the OCR was started against. */
      ocrInputHash: z.string(),
      /**
       * OCR execution-authority digest (PR3 hardening, Commit A):
       * `hashCanonicalJson({planDigest, ruleVersionsDigest})` over the
       * member snapshot's evidence_extraction plan entry + runtime rule
       * versions — the authority the stored OCR was executed under. Additive
       * optional: pre-hardening projections (execution-evidence-v1) parse
       * without it; the freeze-time reuse guard fails closed on mismatch.
       */
      ocrExecutionDigest: z.string().nullable().optional(),
    }),
    /** Product Intelligence imports attached to the member (identity triple, sorted by runId). */
    piEvidence: z.array(z.object({
      runId: z.string(),
      resultHash: z.string(),
      importRecordId: z.string(),
    })),
    /** Semantic assertion: every attached PI import carries a run id + result hash + import record id. */
    piImportComplete: z.literal(true),
  }),
  /** Member-local evidence identity (H2 input): computeExtractionHash(item). */
  evidenceHash: z.string(),
});

export type ExecutionEvidenceProjectionMemberV1 = z.infer<typeof ExecutionEvidenceProjectionMemberSchema>;

/**
 * The full `execution-evidence-v1` projection payload persisted in
 * `classification_cohort_snapshots.payload_json`. The snapshot hash is the
 * canonical digest over this object. Members are sorted by onboardingItemId
 * for deterministic hashing.
 */
export const ExecutionEvidenceProjectionV1Schema = z.object({
  version: z.literal('execution-evidence-v1'),
  cohortId: z.string().max(500),
  batchId: z.string().max(500),
  groupingVersion: z.string().max(500),
  members: z.array(ExecutionEvidenceProjectionMemberSchema).max(50),
});

export type ExecutionEvidenceProjectionV1 = z.infer<typeof ExecutionEvidenceProjectionV1Schema>;

// ─── Frozen Execution-Evidence Projection V2 (Amendment A) ─────────────────────

/**
 * Per-member projection entry (`execution-evidence-v2`). Extends the V1
 * member with the source/provenance authority Amendment A requires:
 *
 * - `itemSourceType` — the item's selected source (`official_page` |
 *   `distributor_record`);
 * - `extractionSourceType` / `extractionMethod` — the extraction row that
 *   produced the frozen evidence (e.g. `distributor_record_v1`);
 * - `sourcingGenerationId` — the current sourcing generation the decision /
 *   materialization belongs to (null when none);
 * - `acceptedEvidenceAttemptIds` / `acceptedProviderIds` — sorted-unique
 *   contributing attempts and providers;
 * - `distributorEvidenceHash` — the canonical distributor-record projection
 *   hash (null for official-page sources);
 * - extraction block additions: `distributorSku`, `manufacturerPartNumber`,
 *   and `variantAttributes` (identity-only, never copy/images/commerce).
 *
 * V1 snapshots remain parse-only; `parseExecutionEvidenceProjection`
 * normalizes them to V2 with official-page provenance (distributor routing
 * did not exist when V1 was written). Persisted V1 bytes are never rewritten.
 */
export const ExecutionEvidenceProjectionMemberV2Schema =
  ExecutionEvidenceProjectionMemberSchema.extend({
    /**
     * Self-versioning member (Amendment A): V2 members carry their own
     * version literal so a frozen member is distinguishable from a V1 member
     * without relying on sibling keys alone.
     */
    version: z.literal('execution-evidence-v2'),
    /**
     * The full V2 (or legacy) sourcing decision is preserved verbatim — the
     * inherited legacy `SourcingDecisionSchema` strips V2-only authority
     * (schemaVersion, sourcingGenerationId, evidenceHash, sourceType,
     * target), which would destroy the provenance the freeze must retain.
     */
    sourcingDecision: SourcingDecisionReadSchema.nullable(),
    itemSourceType: SourceTypeEnum,
    extractionSourceType: SourceTypeEnum,
    extractionMethod: z.string(),
    sourcingGenerationId: z.string().nullable(),
    acceptedEvidenceAttemptIds: z.array(z.string()),
    acceptedProviderIds: z.array(z.string()),
    distributorEvidenceHash: z.string().nullable(),
    extraction: ExecutionEvidenceProjectionMemberSchema.shape.extraction.extend({
      distributorSku: z.string().nullable().default(null),
      manufacturerPartNumber: z.string().nullable().default(null),
      variantAttributes: z.record(z.string(), z.string()).default(() => ({})),
      /**
       * All accepted attempts' values for per-distributor reference fields
       * (distributorSku, distributorUpc, name). The consolidated single pick
       * stays in `distributorSku`; the map preserves every value so
       * Curation never loses distributor data. Sorted-unique arrays.
       */
      distributorReferenceValues: z.record(z.string(), z.array(z.string())).default(() => ({})),
      // Amendment B merchandising fields (M5b-1): explicit bounded fields with
      // safe defaults so pre-merchandising v2 snapshots parse unchanged.
      // Features travel in the existing `bulletPoints` (the v2 materializer
      // maps features there); `merchandisingProvenance` mirrors the
      // materializer's per-field provider/attempt provenance. Price,
      // inventory, and commerce images are never frozen.
      distributorCategory: z.string().nullable().default(null),
      dimensions: z.string().nullable().default(null),
      casePack: z.string().nullable().default(null),
      unitOfMeasure: z.string().nullable().default(null),
      ingredients: z.string().nullable().default(null),
      merchandisingProvenance: z
        .record(
          z.string(),
          z.array(
            z.object({
              attemptId: z.string(),
              providerId: z.string(),
              catalogVersion: z.string(),
              connectionId: z.string(),
              /** Bounded values that THIS attempt supplied for the field (sorted). */
              values: z.array(z.string()),
            }),
          ),
        )
        .default(() => ({})),
    }),
  });

export type ExecutionEvidenceProjectionMemberV2 = z.infer<
  typeof ExecutionEvidenceProjectionMemberV2Schema
>;

/**
 * The full `execution-evidence-v2` projection payload. Members are sorted by
 * onboardingItemId for deterministic hashing.
 */
export const ExecutionEvidenceProjectionV2Schema = z.object({
  version: z.literal('execution-evidence-v2'),
  cohortId: z.string().max(500),
  batchId: z.string().max(500),
  groupingVersion: z.string().max(500),
  members: z.array(ExecutionEvidenceProjectionMemberV2Schema).max(50),
});

export type ExecutionEvidenceProjectionV2 = z.infer<
  typeof ExecutionEvidenceProjectionV2Schema
>;

export const PROJECTION_VERSION_V3 = 'execution-evidence-v3';

/**
 * Milestone 5 (P1-B) — Imported identity provenance for V3 members.
 * Bounded, Zod-validated, lossless raw + normalized envelopes.
 */
export const ImportedIdentityMemberProvenanceSchema = z.object({
  rawEnvelope: z.string().max(5000).nullable().refine(val => {
    if (val === null) return true;
    try {
      const parsed = JSON.parse(val);
      const { canonicalJsonStringify } = require('../stable-id');
      const canonical = canonicalJsonStringify(parsed);
      if (canonical !== val) return false;
      // Zod-validate envelope contents
      const { RawIdentityEnvelopeV1Schema } = require('../../onboarding/imported-identity');
      const res = RawIdentityEnvelopeV1Schema.safeParse(parsed);
      return res.success;
    } catch { return false; }
  }, { message: 'rawEnvelope must be canonical JSON of RawIdentityEnvelopeV1' }),
  normalizedEnvelope: z.string().max(5000).nullable().refine(val => {
    if (val === null) return true;
    try {
      const parsed = JSON.parse(val);
      const { canonicalJsonStringify } = require('../stable-id');
      const canonical = canonicalJsonStringify(parsed);
      if (canonical !== val) return false;
      const { NormalizedIdentityEnvelopeV1Schema } = require('../../onboarding/imported-identity');
      const res = NormalizedIdentityEnvelopeV1Schema.safeParse(parsed);
      return res.success;
    } catch { return false; }
  }, { message: 'normalizedEnvelope must be canonical JSON of NormalizedIdentityEnvelopeV1' }),
  version: z.number().int().min(0).max(10).nullable(),
  provenanceHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  lossy: z.boolean().default(false),
  source: z.enum(['spreadsheet', 'legacy_operational_backfill']).default('spreadsheet'),
  rawHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  normalizedHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
}).superRefine((data, ctx) => {
  const { rawEnvelope, normalizedEnvelope, version, provenanceHash, source, lossy } = data as any;
  // Use shared validator for cross-field invariants, but also enforce per-envelope version/source/hash
  try {
    if (rawEnvelope !== null) {
      const rawParsed = JSON.parse(rawEnvelope);
      if (version !== null && rawParsed.version !== version) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'rawEnvelope version mismatch outer version', path: ['rawEnvelope'] });
      }
      if (rawParsed.parserProvenance?.source !== source && !(version === 0 && source === 'legacy_operational_backfill')) {
        // For v0, raw is null, so not relevant
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'rawEnvelope source mismatch', path: ['rawEnvelope'] });
      }
    }
    if (normalizedEnvelope !== null) {
      const normParsed = JSON.parse(normalizedEnvelope);
      if (version !== null && normParsed.version !== version) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'normalizedEnvelope version mismatch', path: ['normalizedEnvelope'] });
      }
      if (normParsed.parserProvenance?.source !== source) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'normalizedEnvelope source mismatch', path: ['normalizedEnvelope'] });
      }
    }
    if (provenanceHash !== null) {
      const { computeIdentityProvenanceHash, computeLegacyProvenanceHash } = require('../../onboarding/imported-identity');
      const expected = version === 0 ? computeLegacyProvenanceHash(normalizedEnvelope as string) : computeIdentityProvenanceHash(rawEnvelope, normalizedEnvelope);
      if (expected !== provenanceHash) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'provenanceHash mismatch recomputed', path: ['provenanceHash'] });
      }
      // Also check mappingHash equality when both envelopes present
      if (rawEnvelope !== null && normalizedEnvelope !== null) {
        const rawParsed = JSON.parse(rawEnvelope);
        const normParsed = JSON.parse(normalizedEnvelope);
        if (rawParsed.mappingHash !== normParsed.mappingHash) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'mappingHash mismatch between raw/normalized', path: ['provenanceHash'] });
        }
      }
    }
    // Enforce version/lossy/source cross-field via shared validator
    const { validateIdentityTuple } = require('../../onboarding/imported-identity');
    const res = validateIdentityTuple({ rawJson: rawEnvelope, normalizedJson: normalizedEnvelope, version, provenanceHash, lossy });
    if (!res.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: res.reason || 'identity tuple invalid', path: ['version'] });
    }
  } catch (e) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message, path: ['rawEnvelope'] });
  }
});
export type ImportedIdentityMemberProvenance = z.infer<typeof ImportedIdentityMemberProvenanceSchema>;

/**
 * Per-member projection entry (`execution-evidence-v3`). Extends V2 with
 * bounded imported-identity provenance (raw/normalized envelopes, version,
 * provenanceHash, lossy, provenance). V1/V2 snapshots remain parse-only;
 * parseExecutionEvidenceProjection normalizes them to V3 with lossy=false
 * and null envelopes when absent.
 */
export const ExecutionEvidenceProjectionMemberV3Schema =
  ExecutionEvidenceProjectionMemberV2Schema.extend({
    version: z.literal('execution-evidence-v3'),
    importedIdentity: ImportedIdentityMemberProvenanceSchema.default({
      rawEnvelope: null,
      normalizedEnvelope: null,
      version: null,
      provenanceHash: null,
      lossy: false,
      source: 'spreadsheet',
    }),
  });

export type ExecutionEvidenceProjectionMemberV3 = z.infer<
  typeof ExecutionEvidenceProjectionMemberV3Schema
>;

/**
 * The full `execution-evidence-v3` projection payload. Members are sorted by
 * onboardingItemId for deterministic hashing.
 */
export const ExecutionEvidenceProjectionV3Schema = z.object({
  version: z.literal('execution-evidence-v3'),
  cohortId: z.string().max(500),
  batchId: z.string().max(500),
  groupingVersion: z.string().max(500),
  members: z.array(ExecutionEvidenceProjectionMemberV3Schema).max(50),
});

export type ExecutionEvidenceProjectionV3 = z.infer<
  typeof ExecutionEvidenceProjectionV3Schema
>;

/** The versioned execution-evidence projection union (read path). */
export type ExecutionEvidenceProjection = ExecutionEvidenceProjectionV1 | ExecutionEvidenceProjectionV2 | ExecutionEvidenceProjectionV3;

/** The versioned per-member projection union (read path). */
export type ExecutionEvidenceProjectionMember =
  | ExecutionEvidenceProjectionMemberV1
  | ExecutionEvidenceProjectionMemberV2
  | ExecutionEvidenceProjectionMemberV3;

/**
 * Normalize ONE historical V1 member to V2 with official-page provenance.
 * Distributor-record routing did not exist when V1 snapshots were written, so
 * the normalization is truthful by construction. In-memory only — persisted
 * V1 bytes are never rewritten.
 */
export function normalizeExecutionEvidenceProjectionMemberV1(
  member: ExecutionEvidenceProjectionMemberV1,
): ExecutionEvidenceProjectionMemberV2 {
  return {
    ...member,
    version: 'execution-evidence-v2',
    itemSourceType: 'official_page',
    extractionSourceType: 'official_page',
    extractionMethod: '',
    sourcingGenerationId: null,
    acceptedEvidenceAttemptIds: [],
    acceptedProviderIds: [],
    distributorEvidenceHash: null,
    extraction: {
      ...member.extraction,
      distributorSku: null,
      manufacturerPartNumber: null,
      variantAttributes: {},
      distributorCategory: null,
      dimensions: null,
      casePack: null,
      unitOfMeasure: null,
      ingredients: null,
      merchandisingProvenance: {},
      distributorReferenceValues: {},
    },
  };
}

/**
 * Normalize a whole historical V1 projection to V2 (member-wise).
 * In-memory only; never rewrites persisted V1 bytes.
 */
export function normalizeExecutionEvidenceProjectionV1(
  projection: ExecutionEvidenceProjectionV1,
): ExecutionEvidenceProjectionV2 {
  return {
    version: 'execution-evidence-v2',
    cohortId: projection.cohortId,
    batchId: projection.batchId,
    groupingVersion: projection.groupingVersion,
    members: projection.members.map(normalizeExecutionEvidenceProjectionMemberV1),
  };
}

export function normalizeExecutionEvidenceProjectionMemberV2(
  member: ExecutionEvidenceProjectionMemberV2,
): ExecutionEvidenceProjectionMemberV3 {
  return {
    ...member,
    version: 'execution-evidence-v3',
    importedIdentity: {
      rawEnvelope: null,
      normalizedEnvelope: null,
      version: null,
      provenanceHash: null,
      lossy: false,
      source: 'spreadsheet',
    },
  };
}

export function normalizeExecutionEvidenceProjectionV2(
  projection: ExecutionEvidenceProjectionV2,
): ExecutionEvidenceProjectionV3 {
  return {
    version: 'execution-evidence-v3',
    cohortId: projection.cohortId,
    batchId: projection.batchId,
    groupingVersion: projection.groupingVersion,
    members: projection.members.map(normalizeExecutionEvidenceProjectionMemberV2),
  };
}

export function normalizeExecutionEvidenceProjectionV1ToV3(
  projection: ExecutionEvidenceProjectionV1,
): ExecutionEvidenceProjectionV3 {
  return normalizeExecutionEvidenceProjectionV2(normalizeExecutionEvidenceProjectionV1(projection));
}

/**
 * Central parser/adapter for persisted execution-evidence snapshots: tries V3
 * first, then V2, then V1 (parse-only) and normalizes to appropriate shape.
 * Returns V3 for V3 payloads, V2 for V2/V1 payloads (byte-readable for
 * historical tests, new freezes use V3).
 */
export function parseExecutionEvidenceProjection(
  payload: unknown,
): ExecutionEvidenceProjectionV2 | ExecutionEvidenceProjectionV3 {
  const v3 = ExecutionEvidenceProjectionV3Schema.safeParse(payload);
  if (v3.success) return v3.data;
  const v2 = ExecutionEvidenceProjectionV2Schema.safeParse(payload);
  if (v2.success) return v2.data;
  const v1 = ExecutionEvidenceProjectionV1Schema.safeParse(payload);
  if (!v1.success) {
    const isV1 = typeof payload === 'object' && payload !== null && (payload as any).version === 'execution-evidence-v1';
    throw new Error(
      `Execution-evidence projection failed schema validation (none of v1/v2/v3): ${JSON.stringify(isV1 ? v1.error.issues : (v3.success ? [] : v2.error.issues))}`,
    );
  }
  return normalizeExecutionEvidenceProjectionV1(v1.data);
}

/** V3 parser: tries V3 first, then V2, then V1 and normalizes to V3 (new freezes). */
export function parseExecutionEvidenceProjectionV3(
  payload: unknown,
): ExecutionEvidenceProjectionV3 {
  const v3 = ExecutionEvidenceProjectionV3Schema.safeParse(payload);
  if (v3.success) return v3.data;
  const v2 = ExecutionEvidenceProjectionV2Schema.safeParse(payload);
  if (v2.success) return normalizeExecutionEvidenceProjectionV2(v2.data);
  const v1 = ExecutionEvidenceProjectionV1Schema.safeParse(payload);
  if (!v1.success) {
    throw new Error(
      `Execution-evidence projection failed schema validation (none of v1/v2/v3): ${JSON.stringify(v1.error.issues)}`,
    );
  }
  return normalizeExecutionEvidenceProjectionV1ToV3(v1.data);
}

/** Legacy alias: parse and return as V2 shape (for callers not yet migrated to V3). */
export function parseExecutionEvidenceProjectionAsV2(
  payload: unknown,
): ExecutionEvidenceProjectionV2 {
  const v3 = ExecutionEvidenceProjectionV3Schema.safeParse(payload);
  if (v3.success) {
    // Downgrade V3 to V2 by stripping importedIdentity
    return {
      version: 'execution-evidence-v2',
      cohortId: v3.data.cohortId,
      batchId: v3.data.batchId,
      groupingVersion: v3.data.groupingVersion,
// @ts-ignore -- Milestone 5 V3 compat: V2 test fixtures remain byte-readable via parse adapter, new freezes use V3
      members: v3.data.members.map(({ importedIdentity, ...rest }) => rest as ExecutionEvidenceProjectionMemberV2),
    };
  }
  const v2 = ExecutionEvidenceProjectionV2Schema.safeParse(payload);
  if (v2.success) return v2.data;
  const v1 = ExecutionEvidenceProjectionV1Schema.safeParse(payload);
  if (!v1.success) throw new Error(`Execution-evidence projection failed schema validation`);
  return normalizeExecutionEvidenceProjectionV1(v1.data);
}

// ─── Cohort Run Status ─────────────────────────────────────────────────────────

/**
 * Lifecycle status of a parent cohort run (`classification_cohort_runs`, issue
 * #30 PR3 M1; cohort schema v5).
 *
 * - `freezing`: the run was atomically CLAIMED (lease held). Frozen authority
 *   hashes are still being captured; `freezing → running` happens only after
 *   the final freeze CAS transaction commits.
 * - `running`: execution started (`started_at` set); per-member child runs are
 *   being executed against the frozen cohort context.
 * - `completed`: every member completed; the cohort-level semantic work
 *   committed.
 * - `completed_with_abstentions`: every member completed but at least one
 *   stage abstained (no proposal emitted) without failing the run.
 * - `completed_with_member_failures`: members individually failed but the
 *   cohort-level semantic work still committed.
 * - `failed`: the run failed and must be retried to make progress.
 * - `cancelled`: the run was cancelled before completion (e.g. a freezing run
 *   that can never finalize).
 * - `superseded`: a newer run/cohort revision replaced this row. Settable from
 *   ANY state including terminal ones; no transition out of it. Superseded
 *   runs keep their frozen values — they are history, never mutated into a
 *   new truth.
 *
 * The DB enforces at most one CURRENT (non-superseded) run per cohort via the
 * unique partial index `idx_classification_cohort_runs_current`, and the
 * hash-required CHECK (`status = 'freezing' OR (candidate_membership_hash IS
 * NOT NULL AND evidence_snapshot_hash IS NOT NULL)`) forces the two mandatory
 * evidence hashes before a run may leave `freezing`.
 */
export const ClassificationCohortRunStatusEnum = z.enum([
  'freezing',
  'running',
  'completed',
  'completed_with_abstentions',
  'completed_with_member_failures',
  'failed',
  'cancelled',
  'superseded',
]);

export type ClassificationCohortRunStatus = z.infer<typeof ClassificationCohortRunStatusEnum>;

// ─── Execution Product Type Outcome (PR4 C1) ──────────────────────────────────

/**
 * The cohort-level Execution Product Type resolution outcome (PR4,
 * architecture-report §2.4; persisted on `classification_cohort_runs` as the
 * nullable `product_type_outcome` column, cohort schema v6).
 *
 * - `coherent`: every member matched the same Product Type at/above the
 *   confidence floor (execution_product_type_id + product_type_confidence
 *   written).
 * - `coherent_with_abstentions`: ≥1 confident match, no contradiction, ≥1
 *   abstainer (abstainers carry no counter-evidence — DECISION-C).
 * - `conflicted`: ≥2 confident DISTINCT ids — never majority-forced; the id
 *   stays NULL, the run records the conflict and fails deterministically.
 * - `abstained`: no confident match — id/confidence stay NULL, members run
 *   with no execution-type context.
 */
export const ExecutionProductTypeOutcomeEnum = z.enum([
  'coherent',
  'coherent_with_abstentions',
  'conflicted',
  'abstained',
]);

export type ExecutionProductTypeOutcome = z.infer<typeof ExecutionProductTypeOutcomeEnum>;

/**
 * Row shape of a parent cohort run (`classification_cohort_runs`), camelCase.
 * Mirrors the DB columns 1:1 (snake_case rows map via the repo's
 * `mapCohortRunRow`). See the SQL file header for the immutable/mutable field
 * contract.
 */
export const CohortRunSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  cohortId: z.string(),
  /** Frozen cohort.membership_hash at claim (H1 — member identity only). */
  candidateMembershipHash: z.string(),
  /** PR4 (write-once after family coherence); NULL until then. */
  finalMembershipHash: z.string().nullable(),
  /** H2 canonical hash over the frozen member evidence; NULL while freezing. */
  evidenceSnapshotHash: z.string().nullable(),
  /** Reference to the persisted classification_cohort_snapshots row (PR3 M2); NULL while freezing. */
  evidenceSnapshotId: z.string().nullable(),
  /** H3 config authority (nullable mirror). */
  configSnapshotId: z.string().nullable(),
  configSnapshotHash: z.string().nullable(),
  /** H4 Page catalog identity (nullable mirror). */
  pageImportId: z.string().nullable(),
  pageImportHash: z.string().nullable(),
  /** H5 unbound model-execution digest (nullable mirror). */
  modelPolicyDigest: z.string().nullable(),
  /** PR4 placeholder. */
  executionProductTypeId: z.string().nullable(),
  /** PR4 placeholder. */
  productTypeConfidence: z.number().nullable(),
  /** PR4 C1 (v6): Execution Product Type outcome marker; NULL until PR4 resolves it. */
  productTypeOutcome: ExecutionProductTypeOutcomeEnum.nullable(),
  status: ClassificationCohortRunStatusEnum,
  /** Worker id that owns the claim lease. */
  claimedBy: z.string().nullable(),
  claimedAt: z.string().nullable(),
  leaseExpiresAt: z.string().nullable(),
  /** Execution start; set on `freezing → running` (NULL until then). */
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  errorMessage: z.string().nullable(),
  supersededAt: z.string().nullable(),
  createdAt: z.string(),
});

export type CohortRun = z.infer<typeof CohortRunSchema>;

// ─── Proposal Dependency (PR4 C1) ──────────────────────────────────────────────

/**
 * Row shape of a classification proposal dependency
 * (`classification_proposal_dependencies`, cohort schema v6), camelCase.
 * PR4 records dependency METADATA only: when a member SKU run executes under
 * a coherent cohort Execution Product Type, the member's `field_assignment`
 * proposals are stamped with ONE dependency row
 * (`dependency_kind='execution_product_type'`, `dependency_target_id` = the
 * run's execution_product_type_id at proposal creation,
 * `dependency_value_hash` = hashCanonicalJson({executionProductTypeId,
 * productTypeConfidence})). PR5 hardening (issue #30 P2) adds the
 * reviewed-source kind (`dependency_kind='reviewed_product_type'`, target =
 * the reviewed Primary Product Type id, value hash =
 * hashCanonicalJson({reviewedProductTypeId})) for members whose effective
 * Curation Product Type came from a reviewed type. ONLY `field_assignment`
 * proposals are stamped — `primary_product_type` / `category_page` proposals
 * are not downstream of the effective type. The hash is the future
 * invalidation key (PR5+); no recompute/invalidation machinery exists.
 */
export const ProposalDependencySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  proposalId: z.string(),
  /** 'execution_product_type' | 'reviewed_product_type' (PR4 + PR5 hardening P2). */
  dependencyKind: z.string(),
  /** The effective Product Type id at proposal creation (execution or reviewed). */
  dependencyTargetId: z.string(),
  /** hashCanonicalJson({executionProductTypeId, productTypeConfidence}) or hashCanonicalJson({reviewedProductTypeId}) — future invalidation key. */
  dependencyValueHash: z.string(),
  createdAt: z.string(),
});

export type ProposalDependency = z.infer<typeof ProposalDependencySchema>;

// ─── Cohort Outputs (PR6 C1, schema v7) ──────────────────────────────────────

/**
 * The output-kind set of the durable cohort-run outputs table
 * (`classification_cohort_outputs`, cohort schema v7). `output_kind` is a
 * free-form DB string mirroring the `dependency_kind` precedent (no CHECK —
 * SQLite cannot alter a CHECK without a table rebuild); this zod enum is the
 * schema-level validator for the kinds PR6 + PR7 write ('curated_title' and
 * 'coordinated_page').
 */
export const CohortOutputKind = z.enum(['curated_title', 'coordinated_page']);

export type CohortOutputKind = z.infer<typeof CohortOutputKind>;

/**
 * How a persisted curated title was produced:
 *
 * - `llm_cohort`: the cohort title LLM call produced the title.
 * - `cohort_fallback`: the deterministic title formatter after a group-wide
 *   failure (all-or-nothing per multi-item group).
 */
export const CohortTitleSource = z.enum(['llm_cohort', 'cohort_fallback']);

export type CohortTitleSource = z.infer<typeof CohortTitleSource>;

/**
 * The `output_value_json` payload of a `curated_title` output row.
 *
 * PR8 review R1 (BLOCKER 2a): `title` is non-empty — no writer may ever
 * persist an empty title. The coordinator validates every LLM title to at
 * least 2 chars post-trim (empty/invalid responses become the deterministic
 * fallback) and `formatDeterministicTitle` always produces a non-empty
 * string, so tightening the schema breaks no legitimate writer. A persisted
 * empty-title row (pre-tightening corruption) now fails the schema parse at
 * the parent reuse path and fails the affected member closed (see
 * `CohortTitleOutputCorruptError`).
 */
export const CohortTitleOutputSchema = z.object({
  title: z.string().trim().min(1),
  source: CohortTitleSource,
});

export type CohortTitleOutput = z.infer<typeof CohortTitleOutputSchema>;

/**
 * One coordinated Category Page assignment of a `coordinated_page` output
 * row (PR7, issue #30): `pageId`/`pageName` from the frozen page catalog,
 * plus the model-reported confidence (recorded for audit; never an
 * acceptance signal).
 */
export const CohortPageAssignmentSchema = z.object({
  pageId: z.string(),
  pageName: z.string(),
  confidence: z.number(),
});

export type CohortPageAssignment = z.infer<typeof CohortPageAssignmentSchema>;

/**
 * The `output_value_json` payload of a `coordinated_page` output row (PR7,
 * DECISION-C). A Page result is durable whether ASSIGNED or ABSTAINED:
 * `assigned` rows carry the page list with the `llm_cohort` source;
 * `abstained` rows carry the deterministic reason. Rows cover ALL cohort
 * members (groups AND singletons — the P-set), unlike the curated_title
 * kind's multi-item-group-only DECISION-O; both kinds are write-once per
 * (cohort_run_id, output_kind).
 */
export const CohortPageOutputSchema = z.union([
  z.object({
    status: z.literal('assigned'),
    // PR8 review R1 (BLOCKER 2a): an `assigned` row ALWAYS carries at least
    // one page — the coordinator abstains instead of emitting assigned-empty
    // (`normalized.length === 0` → abstain), so no legitimate writer persists
    // an empty page list. A persisted assigned-empty row (pre-tightening
    // corruption) now fails the schema parse at the parent reuse path and
    // fails the affected member closed (see `CohortPageOutputCorruptError`;
    // `materializeCoordinatedPages` also keeps a defensive throw).
    pages: z.array(CohortPageAssignmentSchema).min(1),
    source: z.literal('llm_cohort'),
  }),
  z.object({
    status: z.literal('abstained'),
    reason: z.string(),
  }),
]);

export type CohortPageOutput = z.infer<typeof CohortPageOutputSchema>;

/**
 * Row shape of a persisted cohort output (`classification_cohort_outputs`,
 * cohort schema v7), camelCase. See the SQL file header for the immutable
 * contract: there is no UPDATE path — a new cohort revision is a NEW run id,
 * so superseding the parent run (which leaves its outputs in place)
 * automatically produces NEW output rows under the new run.
 */
export const CohortOutputSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  cohortRunId: z.string(),
  outputKind: CohortOutputKind,
  /** Member onboarding key (onboarding_items.upc). */
  productSku: z.string(),
  /** Canonical title input hash (PR6 workstream 2) — per-row audit. */
  inputHash: z.string(),
  /** JSON payload; for 'curated_title' rows this is CohortTitleOutputSchema. */
  outputValueJson: z.string(),
  /** Audited classification_model_calls id when source='llm_cohort' (soft ref; null for fallback). */
  modelCallId: z.string().nullable(),
  createdAt: z.string(),
});

export type CohortOutput = z.infer<typeof CohortOutputSchema>;

// ─── Grouping Version ──────────────────────────────────────────────────────────

/**
 * Version of the deterministic candidate-grouping algorithm. Grouping rules may
 * evolve; the version is persisted on every cohort so historical cohorts are
 * never silently reinterpreted (issue #30, "Candidate grouping, not
 * authoritative grouping").
 */
export const GROUPING_VERSION = 'product-family-v1';

// ─── Cohort Row Shape ──────────────────────────────────────────────────────────

export const CurationCohortSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  batchId: z.string(),
  /** Deterministic brand + normalized name-stem key (candidate grouping v1). */
  groupKey: z.string(),
  groupLabel: z.string(),
  groupingVersion: z.string(),
  /** Order-insensitive canonical hash over member IDENTITY (sorted onboarding item ids). */
  membershipHash: z.string(),
  status: CohortStatusEnum,
  blockedReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Schema v4 (issue #31 cleanup F3): startedAt/completedAt were REMOVED —
  // execution timestamps belong solely to `classification_cohort_runs`, never
  // to the candidate cohort row.
  supersededAt: z.string().nullable(),
});

export type CurationCohort = z.infer<typeof CurationCohortSchema>;

// ─── Cohort Member Row Shape ───────────────────────────────────────────────────

export const CurationCohortMemberSchema = z.object({
  cohortId: z.string(),
  onboardingItemId: z.string(),
  productSku: z.string().nullable(),
  normalizedBrand: z.string(),
  normalizedNameStem: z.string(),
  /**
   * Why this item belongs to the cohort, e.g.
   * `{"kind":"deterministic_grouping","groupingVersion":"product-family-v1"}`.
   */
  membershipReasonJson: z.record(z.string(), z.unknown()).nullable(),
  /** Canonical hash of extraction/sourcing evidence; NULL until complete. */
  extractionHash: z.string().nullable(),
  ordinal: z.number().int(),
  createdAt: z.string(),
});

export type CurationCohortMember = z.infer<typeof CurationCohortMemberSchema>;

// ─── API DTOs ──────────────────────────────────────────────────────────────────

/**
 * A sibling member that a cohort (or member) is waiting on.
 */
export const CohortWaitingOnItemSchema = z.object({
  itemId: z.string(),
  upc: z.string(),
  name: z.string(),
});

export type CohortWaitingOnItem = z.infer<typeof CohortWaitingOnItemSchema>;

/**
 * A cohort member with derived extraction-readiness state, for the API/UI.
 */
export const CohortMemberReadinessSchema = z.object({
  onboardingItemId: z.string(),
  productSku: z.string().nullable(),
  normalizedBrand: z.string(),
  normalizedNameStem: z.string(),
  extractionHash: z.string().nullable(),
  ordinal: z.number().int(),
  /** Lightweight item identity for display. */
  item: z.object({
    id: z.string(),
    upc: z.string(),
    name: z.string(),
  }),
  ready: z.boolean(),
  state: ReadinessStateSchema,
  blockedReason: z.string().nullable(),
  /** Sibling members this member is waiting on (excludes self). */
  waitingOn: z.array(CohortWaitingOnItemSchema).default(() => []),
});

export type CohortMemberReadiness = z.infer<typeof CohortMemberReadinessSchema>;

/**
 * Full cohort view returned by `GET /api/onboarding/batches/:id/cohorts`.
 * `status` is the cohort's persisted status, refreshed by the service.
 */
export const CurationCohortViewSchema = z.object({
  cohort: CurationCohortSchema,
  members: z.array(CohortMemberReadinessSchema),
  status: CohortStatusEnum,
  /** Derived readiness state: `blocked` when any member failed. */
  state: ReadinessStateSchema,
  blockedReason: z.string().nullable(),
  memberCount: z.number().int(),
  readyCount: z.number().int(),
  waitingOn: z.array(CohortWaitingOnItemSchema).default(() => []),
  /**
   * PR4 C5 additive read-only Execution Product Type exposure (architecture
   * report §9): the cohort's CURRENT run's Execution Type state, surfaced for
   * the review/family panels. The cohort run row stays the sole authority —
   * these fields are derived views and never feed a decision flow. Nullable
   * (no run yet, or run not resolved) and optional (backward compatible:
   * older responses without the fields still parse).
   */
  executionProductTypeId: z.string().nullable().optional(),
  /** The current run's cohort-level Execution Product Type confidence (0..1). */
  productTypeConfidence: z.number().nullable().optional(),
  /** The current run's Execution Product Type resolution outcome marker. */
  productTypeOutcome: ExecutionProductTypeOutcomeEnum.nullable().optional(),
  /** The current run's write-once final membership hash (NULL until finalized). */
  finalMembershipHash: z.string().nullable().optional(),
});

export type CurationCohortView = z.infer<typeof CurationCohortViewSchema>;

/**
 * Durable shadow observation row (epic #46 review round, Package B). One row
 * per cohort per state CHANGE while cohort shadow mode is enabled — the
 * measurable artifact of `BAYSTATE_CMS_COHORT_CURATION_V2_SHADOW_ONLY`.
 */
export const CohortShadowObservationRecordSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  cohortId: z.string(),
  groupKey: z.string().nullable(),
  groupLabel: z.string().nullable(),
  status: z.string().nullable(),
  memberCount: z.number(),
  readyCount: z.number(),
  executionTypeId: z.string().nullable(),
  productTypeConfidence: z.number().nullable(),
  outcome: z.string().nullable(),
  membersJson: z.string().nullable(),
  groupingVersion: z.string().nullable(),
  observedAt: z.string(),
});

export type CohortShadowObservationRecord = z.infer<typeof CohortShadowObservationRecordSchema>;

export const CohortListResponseSchema = z.object({
  cohorts: z.array(CurationCohortViewSchema),
  shadowObservations: z.array(CohortShadowObservationRecordSchema).default([]),
});

export type CohortListResponse = z.infer<typeof CohortListResponseSchema>;

/**
 * Derived per-item family state for the Pipeline Board family indicator.
 */
export const DerivedCohortStateForItemSchema = z.object({
  cohortId: z.string().nullable(),
  groupKey: z.string().nullable(),
  groupLabel: z.string().nullable(),
  status: CohortStatusEnum.nullable(),
  /** Derived readiness state; null when the item has no active cohort. */
  state: ReadinessStateSchema.nullable(),
  blockedReason: z.string().nullable(),
  waitingOn: z.array(CohortWaitingOnItemSchema).default(() => []),
  memberCount: z.number().int(),
  readyCount: z.number().int(),
});

export type DerivedCohortStateForItem = z.infer<typeof DerivedCohortStateForItemSchema>;