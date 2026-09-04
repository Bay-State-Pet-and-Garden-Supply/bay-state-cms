import { getDb } from '../connection';
import { randomUUID } from 'node:crypto';

export interface OnboardingExtractionRow {
  id: string;
  item_id: string;
  source_url: string | null;
  extraction_data_json: string;
  extraction_method: string;
  confidence: number;
  images_json: string | null;
  raw_structured_data_json: string | null;
  source_type: string | null;
  sourcing_generation_id: string | null;
  accepted_evidence_attempt_ids_json: string | null;
  evidence_hash: string | null;
  /** Attestation link for operator manual-evidence rows; null otherwise. May be
   *  absent on rows read from pre-foundation databases (treated as null). */
  manual_attestation_id?: string | null;
  created_at: string;
}

/**
 * Amendment A discriminated extraction input. Two branches:
 *
 * - `official_page` (the pre-Amendment contract, sourceType optional for
 *   backward compatibility): requires a NON-EMPTY source URL; any current
 *   extraction method is allowed.
 * - `distributor_record`: requires a NULL source URL, method
 *   `distributor_record_v1` (Amendment A) or `distributor_record_v2`
 *   (Amendment B), a current sourcing generation, non-empty sorted-unique
 *   accepted evidence attempt ids, and a canonical 64-hex evidence hash.
 *   Provenance is mandatory — a distributor-record extraction without it is
 *   a schema violation.
 */
export type InsertExtractionInput = { itemId: string; extractionDataJson: string; confidence: number; imagesJson?: string | null; rawStructuredDataJson?: string | null } & (
  | {
      sourceType?: 'official_page' | null;
      sourceUrl: string;
      extractionMethod: string;
    }
  | {
      sourceType: 'distributor_record';
      sourceUrl: null | undefined;
      extractionMethod: 'distributor_record_v1' | 'distributor_record_v2';
      sourcingGenerationId: string;
      acceptedEvidenceAttemptIds: string[];
      evidenceHash: string;
    }
  | {
      // Operator manual-evidence row (parent #101): official-brand
      // provenance claimed by the operator — NULL extraction source URL
      // (never a fabricated per-SKU URL), zero automated confidence, no
      // sourcing generation, and a required attestation link.
      sourceType: 'official_page';
      sourceUrl: null;
      extractionMethod: 'manual_evidence_v1';
      manualAttestationId: string;
    }
);

const EVIDENCE_HASH_RE = /^[0-9a-f]{64}$/;

function safeParseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Runtime-widened input shape for defensive validation (no union discriminant). */
type ExtractionInputWide = {
  itemId: string;
  sourceType: 'official_page' | 'distributor_record' | null | undefined;
  sourceUrl: string | null | undefined;
  extractionDataJson: string;
  extractionMethod: string;
  confidence: number;
  imagesJson?: string | null;
  rawStructuredDataJson?: string | null;
  sourcingGenerationId?: string | null;
  acceptedEvidenceAttemptIds?: string[];
  evidenceHash?: string;
  manualAttestationId?: string | null;
};

/**
 * The single extraction writer. Validates the discriminated input fail-closed
 * (official_page requires a real URL; distributor_record requires null URL +
 * `distributor_record_v1` + generation + accepted ids + hash), persists the
 * provenance columns, and returns the durable row.
 */
export function insertExtraction(data: InsertExtractionInput): OnboardingExtractionRow {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  // Widen to a flat (non-union) shape for runtime defensive checks: TS
  // aliased-discriminant narrowing would otherwise derive `never` after the
  // contradictory distributor sourceUrl guard (a typed distributor input can
  // never carry a URL, but untyped runtime callers can). Validation lives in
  // a standalone function so the narrowing never collapses the input inside
  // this writer.
  const input = data as unknown as ExtractionInputWide;

  const { sourceType, sourceUrl, sourcingGenerationId, acceptedEvidenceAttemptIds, evidenceHash, manualAttestationId } =
    validateAndResolveExtractionInput(input, db);

  db.query(
    `INSERT INTO onboarding_extractions
      (id, item_id, source_url, extraction_data_json, extraction_method, confidence, images_json, raw_structured_data_json,
       source_type, sourcing_generation_id, accepted_evidence_attempt_ids_json, evidence_hash, manual_attestation_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.itemId,
    sourceUrl,
    input.extractionDataJson,
    input.extractionMethod,
    input.confidence,
    input.imagesJson ?? null,
    input.rawStructuredDataJson ?? null,
    sourceType,
    sourcingGenerationId,
    acceptedEvidenceAttemptIds.length > 0 ? JSON.stringify(acceptedEvidenceAttemptIds) : null,
    evidenceHash,
    manualAttestationId,
    now,
  );

  return {
    id,
    item_id: input.itemId,
    source_url: sourceUrl,
    extraction_data_json: input.extractionDataJson,
    extraction_method: input.extractionMethod,
    confidence: input.confidence,
    images_json: input.imagesJson ?? null,
    raw_structured_data_json: input.rawStructuredDataJson ?? null,
    source_type: sourceType,
    sourcing_generation_id: sourcingGenerationId,
    accepted_evidence_attempt_ids_json: acceptedEvidenceAttemptIds.length > 0 ? JSON.stringify(acceptedEvidenceAttemptIds) : null,
    evidence_hash: evidenceHash,
    manual_attestation_id: manualAttestationId,
    created_at: now,
  };
}

/**
 * Discriminated validation + projection of the extraction input. Throws on
 * every fail-closed mismatch; returns the persisted column values. Lives
 * outside `insertExtraction` so TS narrowing cannot collapse the union to
 * `never` after the defensive guards.
 */
function validateAndResolveExtractionInput(
  input: ExtractionInputWide,
  db: ReturnType<typeof getDb>,
): {
  sourceType: 'official_page' | 'distributor_record';
  sourceUrl: string | null;
  sourcingGenerationId: string | null;
  acceptedEvidenceAttemptIds: string[];
  evidenceHash: string | null;
  manualAttestationId: string | null;
} {
  // Operator manual-evidence rows (parent #101): NULL extraction source URL
  // (never a fabricated per-SKU URL), official-page provenance, zero
  // automated confidence, no sourcing generation, required attestation link,
  // and an identity never stronger than parent-only / insufficient-evidence.
  if (input.extractionMethod === 'manual_evidence_v1') {
    if (input.sourceUrl !== null && input.sourceUrl !== undefined) {
      throw new Error('manual_evidence_v1 extraction requires a NULL source URL (never a fabricated URL)');
    }
    if (input.sourceType !== undefined && input.sourceType !== null && input.sourceType !== 'official_page') {
      throw new Error("manual_evidence_v1 extraction requires source_type 'official_page'");
    }
    const attestationId = (input.manualAttestationId ?? '').trim();
    if (!attestationId) {
      throw new Error('manual_evidence_v1 extraction requires a manual attestation id');
    }
    if (input.sourcingGenerationId) {
      throw new Error('manual_evidence_v1 extraction must not carry a sourcing generation id');
    }
    if (input.evidenceHash) {
      throw new Error('manual_evidence_v1 extraction must not carry an evidence hash');
    }
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(input.extractionDataJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      payload = parsed as Record<string, unknown>;
    } catch {
      throw new Error('manual_evidence_v1 extraction requires a JSON object extraction payload');
    }
    const identityStatus = payload.identityStatus;
    if (identityStatus !== 'parent_product_only' && identityStatus !== 'insufficient_evidence') {
      throw new Error(
        `manual_evidence_v1 extraction requires identityStatus 'parent_product_only' or 'insufficient_evidence' (never exact/probable match, got '${String(identityStatus)}')`,
      );
    }
    if (payload.manualEvidenceAttestationId !== attestationId) {
      throw new Error('manual_evidence_v1 extraction payload attestation id must match the row attestation link');
    }
    // A `distributor_sheet` per-field source kind never creates distributor
    // linkage (ticket #104): manual rows carry no distributor provenance —
    // linkage lives only in sourcing generations/attempt ids, which the
    // manual route never writes.
    if (payload.distributorRecordProvenance !== null && payload.distributorRecordProvenance !== undefined) {
      throw new Error('manual_evidence_v1 extraction must not carry distributor record provenance');
    }
    for (const key of ['distributorProviderIds', 'distributorEvidenceAttemptIds', 'distributorImageCandidates'] as const) {
      const values = payload[key];
      if (Array.isArray(values) && values.length > 0) {
        throw new Error(`manual_evidence_v1 extraction must not carry distributor linkage (${key})`);
      }
    }
    if (payload.distributorProviderId !== null && payload.distributorProviderId !== undefined) {
      throw new Error('manual_evidence_v1 extraction must not carry a distributor provider id');
    }
    const provenance = payload.fieldProvenance;
    if (provenance && typeof provenance === 'object' && !Array.isArray(provenance)) {
      for (const value of Object.values(provenance as Record<string, unknown>)) {
        if (value !== 'user') {
          throw new Error('manual_evidence_v1 extraction requires per-field provenance \'user\' on every mapped field');
        }
      }
    }
    return {
      sourceType: 'official_page',
      sourceUrl: null,
      sourcingGenerationId: null,
      acceptedEvidenceAttemptIds: [],
      evidenceHash: null,
      manualAttestationId: attestationId,
    };
  }

  const isDistributorRecord = input.sourceType === 'distributor_record';

  if (isDistributorRecord) {
    if (input.sourceUrl !== null && input.sourceUrl !== undefined) {
      throw new Error('distributor_record extraction requires a NULL source URL (never a fabricated URL)');
    }
    if (input.extractionMethod !== 'distributor_record_v1' && input.extractionMethod !== 'distributor_record_v2') {
      throw new Error(
        `distributor_record extraction requires extractionMethod 'distributor_record_v1' or 'distributor_record_v2' (got '${input.extractionMethod}')`,
      );
    }
    if (!input.sourcingGenerationId) {
      throw new Error('distributor_record extraction requires a sourcing generation id');
    }
    if (!Array.isArray(input.acceptedEvidenceAttemptIds) || input.acceptedEvidenceAttemptIds.length === 0) {
      throw new Error('distributor_record extraction requires non-empty accepted evidence attempt ids');
    }
    if (new Set(input.acceptedEvidenceAttemptIds).size !== input.acceptedEvidenceAttemptIds.length) {
      throw new Error('distributor_record extraction accepted evidence attempt ids must be unique');
    }
    if (!EVIDENCE_HASH_RE.test(input.evidenceHash ?? '')) {
      throw new Error('distributor_record extraction requires a canonical 64-hex evidence hash');
    }
    // The generation must be the item's CURRENT generation (stale or foreign
    // generations can never materialize a distributor-record extraction).
    const current = db
      .query('SELECT id FROM sourcing_generations WHERE item_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(input.itemId) as { id: string } | undefined;
    if (!current || current.id !== input.sourcingGenerationId) {
      throw new Error("distributor_record extraction requires the item's CURRENT sourcing generation");
    }
    return {
      sourceType: 'distributor_record',
      sourceUrl: null,
      sourcingGenerationId: input.sourcingGenerationId,
      acceptedEvidenceAttemptIds: [...new Set(input.acceptedEvidenceAttemptIds)].sort(),
      evidenceHash: input.evidenceHash!,
      manualAttestationId: null,
    };
  }

  if (!input.sourceUrl || !input.sourceUrl.trim()) {
    throw new Error('official_page extraction requires a non-empty source URL');
  }
  return {
    sourceType: input.sourceType ?? 'official_page',
    sourceUrl: input.sourceUrl,
    sourcingGenerationId: null,
    acceptedEvidenceAttemptIds: [],
    evidenceHash: null,
    manualAttestationId: null,
  };
}

/**
 * Update the extraction_data_json on the latest extraction record for an item.
 * Used when a user edits extraction results via the pipeline board save flow.
 *
 * MD round-7 (defect 1b): row-level immutability — a PRESERVED
 * distributor_record row is audit-only and can never be mutated through this
 * writer, even after the item reverted to an official source. Returns false
 * (no mutation) when no row exists or the latest row is distributor-sourced.
 */
export function updateLatestExtractionData(itemId: string, extractionDataJson: string): boolean {
  const db = getDb();
  const row = db
    .query('SELECT source_type, extraction_method FROM onboarding_extractions WHERE item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(itemId) as { source_type: string | null; extraction_method: string } | undefined;
  if (!row || (row.source_type ?? 'official_page') === 'distributor_record') return false;
  // Parent #101: operator manual-evidence rows are never clobbered by the
  // board save flow — manual work is edited via withdraw-then-resubmit.
  if (row.extraction_method === 'manual_evidence_v1') return false;
  db.query(
    `UPDATE onboarding_extractions
     SET extraction_data_json = ?
     WHERE id = (SELECT id FROM onboarding_extractions WHERE item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1)`,
  ).run(extractionDataJson, itemId);
  return true;
}

export function getLatestExtraction(itemId: string): OnboardingExtractionRow | undefined {
  const db = getDb();
  return db.query(
    'SELECT * FROM onboarding_extractions WHERE item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
  ).get(itemId) as OnboardingExtractionRow | undefined;
}

/**
 * Find the durable distributor-record extraction row for an item, if any.
 *
 * Find-by-immutable-identity-then-validate: looks up ANY extraction row with
 * method 'distributor_record_v1' OR 'distributor_record_v2' (regardless of
 * hash/source_type/generation) and returns the latest (created_at DESC,
 * rowid DESC). The materializer's idempotent-retry guard uses this shape so
 * every provenance column is GENUINELY revalidated — if the row exists it
 * must match the recomputed decision in full, and any divergence fails
 * closed rather than inserting a second (possibly divergent) row. A
 * mis-shaped row carrying either method is also detected, so the materializer
 * can never insert a second row to hide divergence.
 */
export function findDistributorRecordExtraction(itemId: string): OnboardingExtractionRow | undefined {
  const db = getDb();
  const row = db.query(
    `SELECT * FROM onboarding_extractions
     WHERE item_id = ? AND (
       extraction_method IN ('distributor_record_v1', 'distributor_record_v2')
       OR source_type = 'distributor_record'
     )
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(itemId) as OnboardingExtractionRow | undefined;
  return row;
}

export interface ExtractionBinding {
  sourceUrl: string | null;
  sourceType: 'official_page' | 'distributor_record';
  extractionMethod: string;
  sourcingGenerationId: string | null;
  acceptedEvidenceAttemptIds: string[];
  evidenceHash: string | null;
  /** Attestation link for operator manual-evidence rows (parent #101); null otherwise. */
  manualAttestationId?: string | null;
}

/**
 * Latest extraction BINDINGS per onboarding item, in ONE batched query
 * (Amendment A replacement for the URL-only `getLatestExtractionSourcesByItemIds`):
 * source URL (nullable), source type, extraction method, sourcing generation,
 * canonical accepted-evidence-attempt ids, and evidence hash. Returns a Map
 * keyed by item id; items without any extraction row are absent from the map.
 */
export function getLatestExtractionBindingsByItemIds(itemIds: string[]): Map<string, ExtractionBinding> {
  const db = getDb();
  const bindings = new Map<string, ExtractionBinding>();
  if (itemIds.length === 0) return bindings;
  const placeholders = itemIds.map(() => '?').join(', ');
  // Window-function tiebreaker: equal created_at rows resolve by rowid DESC,
  // so the latest extraction is deterministic even on millisecond ties.
  const rows = db.query(
    `SELECT * FROM (
       SELECT e.*, ROW_NUMBER() OVER (
         PARTITION BY e.item_id
         ORDER BY e.created_at DESC, e.rowid DESC
       ) AS rn
       FROM onboarding_extractions e
       WHERE e.item_id IN (${placeholders})
     ) WHERE rn = 1`,
  ).all(...itemIds) as OnboardingExtractionRow[];
  for (const row of rows) {
    bindings.set(row.item_id, {
      sourceUrl: row.source_url,
      sourceType: (row.source_type ?? 'official_page') as 'official_page' | 'distributor_record',
      extractionMethod: row.extraction_method,
      sourcingGenerationId: row.sourcing_generation_id,
      acceptedEvidenceAttemptIds: safeParseJsonArray(row.accepted_evidence_attempt_ids_json),
      evidenceHash: row.evidence_hash,
      manualAttestationId: (row as { manual_attestation_id?: string | null }).manual_attestation_id ?? null,
    });
  }
  return bindings;
}
