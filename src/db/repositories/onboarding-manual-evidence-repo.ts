import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../connection';
import {
  ManualEvidenceAttestationSchema,
  ManualEvidenceSourceKindEnum,
} from '../../shared/schemas/onboarding';
import { canonicalJsonStringify } from '../../shared/stable-id';

/**
 * Manual-evidence attestation store (parent #101, ticket #102 foundation).
 *
 * One row per operator manual-evidence submission. The family reference URL
 * is reference-only context — never the extraction source. Value hashes are
 * server-computed canonical SHA-256 per field; gates refuse any extraction
 * payload whose checklist hash does not match (hash-match discipline).
 *
 * Foundation scope only: attestation CRUD + hash verification + read-only
 * observation counts. No stage transitions, no evidence emission, no UI.
 */

export type ManualEvidenceSourceKind =
  (typeof ManualEvidenceSourceKindEnum.options)[number];

export interface ManualEvidenceFieldChecklistInput {
  sourceKind: ManualEvidenceSourceKind;
  referenceUrl?: string | null;
}

/** One per-image rights approval supplied by the operator for a manual image. */
export interface ManualEvidenceImageRightInput {
  imageUrl: string;
}

export interface CreateManualEvidenceAttestationInput {
  itemId: string;
  batchId?: string | null;
  operatorId: string;
  /** Raw per-field values being attested (at least one required). */
  fieldValues: Record<string, unknown>;
  /** Per-field source kinds, keyed by the same field names. */
  fieldSources: Record<string, ManualEvidenceFieldChecklistInput>;
  familyReferenceUrl?: string | null;
  /**
   * Per-image rights approvals (ticket #104). Every operator-supplied
   * manual image URL needs one; stored server-derived with
   * approvalOrigin 'operator_review'. Empty when no images are submitted.
   */
  imageRights?: ManualEvidenceImageRightInput[];
  /**
   * Operator-pasted family page text snapshot (ticket #104, optional,
   * reference only). The review gate compares manual fields against it;
   * never trusted evidence, never fetched from the network.
   */
  familyReferenceText?: string | null;
  notes?: string | null;
}

/** One stored per-image rights approval (server-derived, fail-closed). */
export interface ManualEvidenceImageRight {
  imageUrl: string;
  rightsAttested: true;
  approvalOrigin: 'operator_review';
  attestedBy: string;
  attestedAt: string;
}

export interface ManualEvidenceAttestationRow {
  attestation_id: string;
  item_id: string;
  batch_id: string | null;
  operator_id: string;
  attested_at: string;
  family_reference_url: string | null;
  field_checklist_json: string;
  value_hashes_json: string;
  /** JSON array of ManualEvidenceImageRight; null when no images were submitted. */
  image_rights_json: string | null;
  /** Operator-pasted family text snapshot; null when not supplied. */
  family_reference_text: string | null;
  superseded_at: string | null;
  created_at: string;
}

const VALUE_HASH_RE = /^[a-f0-9]{64}$/;

/** Canonical SHA-256 hash of one field value (server-computed). */
export function hashManualEvidenceFieldValue(value: unknown): string {
  return createHash('sha256').update(canonicalJsonStringify(value), 'utf8').digest('hex');
}

/** Build the canonical per-field value-hash map for an attestation. */
export function computeManualEvidenceValueHashes(
  fieldValues: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of Object.keys(fieldValues).sort()) {
    out[field] = hashManualEvidenceFieldValue(fieldValues[field]);
  }
  return out;
}

function parseJsonObject(raw: string, what: string): Record<string, any> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`manual evidence attestation has invalid ${what} JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`manual evidence attestation has invalid ${what} shape`);
  }
  return parsed as Record<string, any>;
}

/**
 * Create one attestation row. Fail-closed: requires a non-empty item id,
 * operator id, at least one field value, and a checklist entry (with a valid
 * source kind) for every field value. Family reference URL, when present,
 * must be an http(s) URL; it is stored reference-only.
 */
export function createManualEvidenceAttestation(
  input: CreateManualEvidenceAttestationInput,
): ManualEvidenceAttestationRow {
  const db = getDb();
  const itemId = (input.itemId ?? '').trim();
  const operatorId = (input.operatorId ?? '').trim();
  if (!itemId) throw new Error('manual evidence attestation requires an item id');
  if (!operatorId) throw new Error('manual evidence attestation requires an operator id');

  const fields = Object.keys(input.fieldValues ?? {});
  if (fields.length === 0) {
    throw new Error('manual evidence attestation requires at least one field value');
  }

  const checklist: Record<string, { valueHash: string; sourceKind: string; referenceUrl: string | null }> = {};
  const valueHashes = computeManualEvidenceValueHashes(input.fieldValues);
  for (const field of fields) {
    const source = input.fieldSources?.[field];
    if (!source) {
      throw new Error(`manual evidence attestation missing checklist entry for field '${field}'`);
    }
    const kind = ManualEvidenceSourceKindEnum.safeParse(source.sourceKind);
    if (!kind.success) {
      throw new Error(`manual evidence attestation has invalid source kind for field '${field}'`);
    }
    const ref = source.referenceUrl ?? null;
    if (ref !== null) {
      let url: URL;
      try {
        url = new URL(ref);
      } catch {
        throw new Error(`manual evidence attestation has invalid reference URL for field '${field}'`);
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`manual evidence attestation has invalid reference URL for field '${field}'`);
      }
    }
    checklist[field] = { valueHash: valueHashes[field], sourceKind: kind.data, referenceUrl: ref };
  }

  const familyReferenceUrl = input.familyReferenceUrl ?? null;
  if (familyReferenceUrl !== null) {
    let url: URL;
    try {
      url = new URL(familyReferenceUrl);
    } catch {
      throw new Error('manual evidence attestation has invalid family reference URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('manual evidence attestation has invalid family reference URL');
    }
  }

  const notes = input.notes ?? null;
  if (notes !== null && notes.length > 2000) {
    throw new Error('manual evidence attestation notes exceed 2000 characters');
  }

  // Per-image rights (ticket #104): every URL must be http(s); the approval
  // rows are server-derived (operator + timestamp + manual origin) so the
  // client can never smuggle provenance. Empty when no images are submitted.
  const imageRightsInput = input.imageRights ?? [];
  const imageRights: ManualEvidenceImageRight[] = [];
  const rightsStampedAt = new Date().toISOString();
  for (const entry of imageRightsInput) {
    const imageUrl = (entry?.imageUrl ?? '').trim();
    let url: URL;
    try {
      url = new URL(imageUrl);
    } catch {
      throw new Error('manual evidence image rights has an invalid image URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('manual evidence image rights has an invalid image URL');
    }
    imageRights.push({
      imageUrl,
      rightsAttested: true,
      approvalOrigin: 'operator_review',
      attestedBy: operatorId,
      attestedAt: rightsStampedAt,
    });
  }

  // Family-reference text snapshot (ticket #104): bounded reference-only
  // context for the inheritance guard. Empty collapses to null.
  const rawSnapshot = (input.familyReferenceText ?? '').trim();
  const familyReferenceText = rawSnapshot.length > 0 ? rawSnapshot : null;
  if (familyReferenceText !== null && familyReferenceText.length > 8000) {
    throw new Error('manual evidence family reference text exceeds 8000 characters');
  }

  const attestationId = randomUUID();
  const now = new Date().toISOString();
  const parsed = ManualEvidenceAttestationSchema.safeParse({
    attestationId,
    itemId,
    batchId: input.batchId ?? null,
    operatorId,
    attestedAt: now,
    familyReferenceUrl,
    fieldChecklist: checklist,
    noFamilyInheritanceAttested: true,
    perSkuVerificationAttested: true,
    rightsAttestedForImages: true,
    notes,
    supersededAt: null,
  });
  if (!parsed.success) {
    throw new Error(
      `manual evidence attestation failed validation: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    );
  }

  const checklistJson = canonicalJsonStringify(checklist);
  const hashesJson = canonicalJsonStringify(valueHashes);
  const imageRightsJson = imageRights.length > 0 ? canonicalJsonStringify(imageRights) : null;
  db.query(
    `INSERT INTO onboarding_manual_evidence_attestations
      (attestation_id, item_id, batch_id, operator_id, attested_at,
       family_reference_url, field_checklist_json, value_hashes_json,
       image_rights_json, family_reference_text,
       superseded_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    attestationId,
    itemId,
    input.batchId ?? null,
    operatorId,
    now,
    familyReferenceUrl,
    checklistJson,
    hashesJson,
    imageRightsJson,
    familyReferenceText,
    now,
  );

  return {
    attestation_id: attestationId,
    item_id: itemId,
    batch_id: input.batchId ?? null,
    operator_id: operatorId,
    attested_at: now,
    family_reference_url: familyReferenceUrl,
    field_checklist_json: checklistJson,
    value_hashes_json: hashesJson,
    image_rights_json: imageRightsJson,
    family_reference_text: familyReferenceText,
    superseded_at: null,
    created_at: now,
  };
}

/** Fetch one attestation by id (null when absent). */
export function getManualEvidenceAttestation(
  attestationId: string,
): ManualEvidenceAttestationRow | null {
  const db = getDb();
  const row = db
    .query('SELECT * FROM onboarding_manual_evidence_attestations WHERE attestation_id = ?')
    .get(attestationId) as ManualEvidenceAttestationRow | undefined;
  return row ?? null;
}

/** Latest non-superseded attestation for an item (null when none). */
export function getActiveManualEvidenceAttestationForItem(
  itemId: string,
): ManualEvidenceAttestationRow | null {
  const db = getDb();
  const row = db
    .query(
      `SELECT * FROM onboarding_manual_evidence_attestations
       WHERE item_id = ? AND superseded_at IS NULL
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(itemId) as ManualEvidenceAttestationRow | undefined;
  return row ?? null;
}

/** All attestations for an item, newest first (includes superseded). */
export function listManualEvidenceAttestationsForItem(
  itemId: string,
): ManualEvidenceAttestationRow[] {
  const db = getDb();
  return db
    .query(
      `SELECT * FROM onboarding_manual_evidence_attestations
       WHERE item_id = ? ORDER BY created_at DESC, rowid DESC`,
    )
    .all(itemId) as ManualEvidenceAttestationRow[];
}

/** Withdraw an attestation: mark superseded (restores prior blocked state upstream). */
export function supersedeManualEvidenceAttestation(attestationId: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .query(
      `UPDATE onboarding_manual_evidence_attestations
       SET superseded_at = ? WHERE attestation_id = ? AND superseded_at IS NULL`,
    )
    .run(now, attestationId) as unknown as { changes: number };
  return (result?.changes ?? 0) > 0;
}

/**
 * Parse the stored per-image rights approvals (ticket #104). Returns []
 * when no images were submitted. Throws on malformed JSON or on entries
 * that are not rights-attested operator approvals (fail-closed: the gate
 * refuses rather than promoting unattested images).
 */
export function parseManualEvidenceImageRights(
  row: Pick<ManualEvidenceAttestationRow, 'image_rights_json'>,
): ManualEvidenceImageRight[] {
  const raw = row.image_rights_json;
  if (raw === null || raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('manual evidence image rights has invalid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('manual evidence image rights must be an array');
  const out: ManualEvidenceImageRight[] = [];
  for (const entry of parsed) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof (entry as { imageUrl?: unknown }).imageUrl !== 'string' ||
      (entry as { rightsAttested?: unknown }).rightsAttested !== true ||
      (entry as { approvalOrigin?: unknown }).approvalOrigin !== 'operator_review'
    ) {
      throw new Error('manual evidence image rights entry is not an attested operator approval');
    }
    out.push(entry as ManualEvidenceImageRight);
  }
  return out;
}

/**
 * Hash-match discipline: recompute canonical per-field hashes for the given
 * payload and compare against the stored checklist. Returns true only when
 * every checklist field matches and no extra/missing fields exist. Throws
 * when the attestation is absent or superseded.
 */
export function verifyManualEvidenceAttestationHash(
  attestationId: string,
  fieldValues: Record<string, unknown>,
): boolean {
  const row = getManualEvidenceAttestation(attestationId);
  if (!row) throw new Error('manual evidence attestation not found');
  if (row.superseded_at !== null) throw new Error('manual evidence attestation is superseded');
  const checklist = parseJsonObject(row.field_checklist_json, 'field checklist');
  const expected = computeManualEvidenceValueHashes(fieldValues);
  const checklistFields = Object.keys(checklist).sort();
  const payloadFields = Object.keys(expected).sort();
  if (JSON.stringify(checklistFields) !== JSON.stringify(payloadFields)) return false;
  for (const field of checklistFields) {
    const entry = checklist[field] as { valueHash?: unknown };
    if (typeof entry?.valueHash !== 'string' || !VALUE_HASH_RE.test(entry.valueHash)) return false;
    if (entry.valueHash !== expected[field]) return false;
  }
  return true;
}

export interface ManualEvidenceObservation {
  attestationCount: number;
  activeAttestationCount: number;
  manualExtractionCount: number;
  coveredItemCount: number;
  uncoveredAttestationCount: number;
}

/**
 * Read-only observation counts for rollout monitoring (runbook). Never writes.
 * coveredItemCount = active attestations whose item also has a manual-method
 * extraction row; uncovered = active attestations without one.
 */
export function getManualEvidenceObservation(): ManualEvidenceObservation {
  const db = getDb();
  const hasAttestationTable = (
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'onboarding_manual_evidence_attestations'",
      )
      .get() as { name: string } | undefined
  )?.name === 'onboarding_manual_evidence_attestations';
  if (!hasAttestationTable) {
    return {
      attestationCount: 0,
      activeAttestationCount: 0,
      manualExtractionCount: 0,
      coveredItemCount: 0,
      uncoveredAttestationCount: 0,
    };
  }
  const att = (db
    .query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN superseded_at IS NULL THEN 1 ELSE 0 END) AS active
       FROM onboarding_manual_evidence_attestations`,
    )
    .get() as { total: number; active: number | null });
  let manualExtractionCount: number;
  let coveredItemCount: number;
  try {
    manualExtractionCount = (
      db
        .query(
          "SELECT COUNT(*) AS cnt FROM onboarding_extractions WHERE extraction_method = 'manual_evidence_v1'",
        )
        .get() as { cnt: number }
    ).cnt;
    coveredItemCount = (
      db
        .query(
          `SELECT COUNT(DISTINCT a.item_id) AS cnt
           FROM onboarding_manual_evidence_attestations a
           JOIN onboarding_extractions e
             ON e.item_id = a.item_id AND e.extraction_method = 'manual_evidence_v1'
           WHERE a.superseded_at IS NULL`,
        )
        .get() as { cnt: number }
    ).cnt;
  } catch {
    manualExtractionCount = 0;
    coveredItemCount = 0;
  }
  const active = att.active ?? 0;
  return {
    attestationCount: att.total,
    activeAttestationCount: active,
    manualExtractionCount,
    coveredItemCount,
    uncoveredAttestationCount: Math.max(0, active - coveredItemCount),
  };
}
