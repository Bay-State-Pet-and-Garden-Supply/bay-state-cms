import { getDb } from '../db/connection';
import { getManualEvidenceFlags } from './flags';
import { findItemById } from '../db/repositories/onboarding-item-repo';
import { encodeForStorage, readStorageVersion, stagePredicateParams } from '../db/repositories/onboarding-stage-vocabulary-repo';
import { toCanonicalStage } from '../shared/onboarding-stage-vocabulary';
import {
  insertExtraction,
  getLatestExtraction,
  findDistributorRecordExtraction,
} from '../db/repositories/onboarding-extraction-repo';
import {
  createManualEvidenceAttestation,
  getActiveManualEvidenceAttestationForItem,
  supersedeManualEvidenceAttestation,
} from '../db/repositories/onboarding-manual-evidence-repo';
import { findProfileByDomain as defaultFindProfileByDomain } from '../db/repositories/extractor-profile-repo';
import { ExtractionDataSchema } from '../shared/schemas/onboarding';

/**
 * Manual-evidence extraction route (parent #101, ticket #104 full set).
 *
 * The single audited operator path from `extraction/failed` (profile-blocked
 * or triaged family-page-only) to `extraction/completed`. Full field set:
 * title (required) + brand/description/bullets/weight/dimensions/images
 * (optional) with per-field source kinds, per-image rights approvals, and
 * an optional pasted family-reference text snapshot (inheritance guard).
 * The family page URL/text are reference-only attachments — never the
 * extraction source. The automated worker never calls this module
 * (no auto-degradation by construction: every entry requires an explicit
 * operator id + attestation).
 */

import { MANUAL_EVIDENCE_ACTIVE_RETRY_CODE, MANUAL_EVIDENCE_METHOD } from './manual-evidence-eligibility';

export { MANUAL_EVIDENCE_ACTIVE_RETRY_CODE };

/** Stable fail-closed reject codes for the manual-evidence transition. */
export type ManualEvidenceRejectCode =
  | 'manual_evidence_disabled'
  | 'item_not_found'
  | 'workspace_mismatch'
  | 'sourcing_curation_bypass_rejected'
  | 'discovery_to_manual_rejected'
  | 'extraction_never_attempted'
  | 'extraction_not_failed'
  | 'not_profile_blocked'
  | 'profile_now_healthy'
  | 'distributor_record_exists'
  | 'manual_title_missing'
  | 'manual_attestation_incomplete'
  | 'manual_field_invalid'
  | 'manual_image_rights_missing'
  | 'invalid_reference_url'
  | 'concurrent_state_change'
  | 'no_manual_evidence_to_withdraw';

export type SubmitManualEvidenceResult =
  | { ok: true; attestationId: string; extractionId: string }
  | { ok: false; code: ManualEvidenceRejectCode; reason: string };

export interface ManualEvidenceAttestationInput {
  noFamilyInheritance: boolean;
  perSkuVerified: boolean;
  rightsAttested: boolean;
  notes?: string | null;
}

export interface SubmitManualEvidenceInput {
  itemId: string;
  workspaceId: string;
  operatorId: string;
  title: string;
  brand?: string | null;
  description?: string | null;
  bulletPoints?: string[] | null;
  weight?: string | null;
  dimensions?: string | null;
  primaryImage?: string | null;
  additionalImages?: string[] | null;
  /** Per-field source kinds; absent fields default to operator_transcription. */
  fieldSources?: Record<string, string> | null;
  /** Per-image rights approvals; every submitted image URL needs one. */
  imageApprovals?: Array<{ imageUrl: string; rightsAttested: boolean }> | null;
  /** Operator-pasted family page text snapshot (optional, reference only). */
  familyReferenceText?: string | null;
  familyReferenceUrl?: string | null;
  /** Operator-confirmed family-page-only triage for non-profile failures. */
  familyPageOnlyConfirmed?: boolean;
  /** Required override reason when a qualified distributor record exists. */
  overrideDistributorReason?: string | null;
  attestation: ManualEvidenceAttestationInput;
}

export interface WithdrawManualEvidenceInput {
  itemId: string;
  workspaceId: string;
  operatorId: string;
}

export type WithdrawManualEvidenceResult =
  | { ok: true; supersededAttestationId: string }
  | { ok: false; code: ManualEvidenceRejectCode; reason: string };

/** Test seam: profile-health lookup (default hits the extractor-profile repo). */
export interface ManualEvidenceDeps {
  findProfileByDomain: (domain: string) => unknown;
}

const defaultDeps: ManualEvidenceDeps = { findProfileByDomain: defaultFindProfileByDomain };

import { convertToLbs } from '../shared/weight-converter';
import {
  MANUAL_EVIDENCE_FIELD_NAMES,
  buildManualEvidenceFieldValues,
  deriveManualEvidenceIdentityStatus,
  isManualEvidenceEligible,
  isManualEvidenceProfileBlockedError,
  resolveManualEvidenceDomain,
} from './manual-evidence-eligibility';
import { ManualEvidenceSourceKindEnum } from '../shared/schemas/onboarding';

export {
  deriveManualEvidenceIdentityStatus,
  isManualEvidenceEligible,
  isManualEvidenceProfileBlockedError,
  resolveManualEvidenceDomain,
};

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Audited operator submission of manual evidence for one blocked item.
 * Fail-closed: every guard rejects with a stable code; nothing is written
 * until all guards pass, and all writes land in one transaction.
 */
export function submitManualEvidence(
  input: SubmitManualEvidenceInput,
  deps: ManualEvidenceDeps = defaultDeps,
): SubmitManualEvidenceResult {
  if (!getManualEvidenceFlags().enabled) {
    return { ok: false, code: 'manual_evidence_disabled', reason: 'The manual-evidence route is disabled.' };
  }
  const item = findItemById(input.itemId);
  if (!item) {
    return { ok: false, code: 'item_not_found', reason: `Onboarding item ${input.itemId} not found.` };
  }
  const db = getDb();
  const batch = db
    .query('SELECT workspace_id FROM onboarding_batches WHERE id = ?')
    .get(item.batchId) as { workspace_id: string } | undefined;
  if (!batch || batch.workspace_id !== input.workspaceId) {
    return { ok: false, code: 'workspace_mismatch', reason: 'Item belongs to a different workspace.' };
  }
  // Slice 5b native: canonical stage guards (dual read — either stored spelling).
  let canonicalStage: string;
  try {
    canonicalStage = toCanonicalStage(item.stage);
  } catch {
    return {
      ok: false,
      code: 'extraction_not_failed',
      reason: `Manual evidence entry is only from extraction/failed (item is ${item.stage}/${item.stageStatus}).`,
    };
  }
  if (canonicalStage === 'route_sources') {
    return {
      ok: false,
      code: 'sourcing_curation_bypass_rejected',
      reason: 'Manual evidence is never reachable from sourcing; sourcing items must go through discovery first.',
    };
  }
  if (canonicalStage === 'find_product_page') {
    return {
      ok: false,
      code: 'discovery_to_manual_rejected',
      reason: 'Discovery must resolve first; manual evidence is submitted from extraction.',
    };
  }
  if (canonicalStage !== 'collect_details') {
    return {
      ok: false,
      code: 'extraction_not_failed',
      reason: `Manual evidence entry is only from extraction/failed (item is ${item.stage}/${item.stageStatus}).`,
    };
  }
  // Idempotent replay: an already-completed manual submission with an
  // ACTIVE attestation returns the existing ids (double-click safe) instead
  // of writing a second row. Withdraw-then-resubmit still creates fresh
  // rows because withdrawal supersedes the attestation.
  if (canonicalStage === 'collect_details' && item.stageStatus === 'completed') {
    const latestCompleted = getLatestExtraction(input.itemId);
    if (latestCompleted && latestCompleted.extraction_method === MANUAL_EVIDENCE_METHOD) {
      const activeCompleted = getActiveManualEvidenceAttestationForItem(input.itemId);
      const linkedId = (latestCompleted as { manual_attestation_id?: string | null }).manual_attestation_id ?? null;
      if (activeCompleted && linkedId === activeCompleted.attestation_id) {
        return { ok: true, attestationId: activeCompleted.attestation_id, extractionId: latestCompleted.id };
      }
    }
    return {
      ok: false,
      code: 'extraction_not_failed',
      reason: `Manual evidence entry is only from extraction/failed (item is extraction/${item.stageStatus}).`,
    };
  }
  if (item.stageStatus === 'pending') {
    return {
      ok: false,
      code: 'extraction_never_attempted',
      reason: 'Automated extraction was never attempted; manual evidence requires a prior fail-closed failure.',
    };
  }
  if (item.stageStatus !== 'failed') {
    return {
      ok: false,
      code: 'extraction_not_failed',
      reason: `Manual evidence entry is only from extraction/failed (item is extraction/${item.stageStatus}).`,
    };
  }
  const profileBlocked = isManualEvidenceProfileBlockedError(item.errorMessage);
  if (!profileBlocked && !input.familyPageOnlyConfirmed) {
    return {
      ok: false,
      code: 'not_profile_blocked',
      reason: 'Non-profile failures require explicit operator confirmation that the brand is family-page-only.',
    };
  }

  const title = (input.title ?? '').trim();
  if (!title) {
    return { ok: false, code: 'manual_title_missing', reason: 'A per-SKU title is required for manual evidence.' };
  }
  const brand = (input.brand ?? '').trim() || null;
  const descriptionRaw = (input.description ?? '').trim() || null;
  if (descriptionRaw !== null && descriptionRaw.length > 4000) {
    return { ok: false, code: 'manual_field_invalid', reason: 'The manual description exceeds 4000 characters.' };
  }
  const description = descriptionRaw;
  const rawBullets = input.bulletPoints ?? [];
  if (!Array.isArray(rawBullets)) {
    return { ok: false, code: 'manual_field_invalid', reason: 'Manual bullet points must be an array of strings.' };
  }
  const bulletPoints = rawBullets
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (bulletPoints.length > 10) {
    return { ok: false, code: 'manual_field_invalid', reason: 'Manual evidence allows at most 10 bullet points.' };
  }
  for (const bullet of bulletPoints) {
    if (bullet.length > 500) {
      return { ok: false, code: 'manual_field_invalid', reason: 'A manual bullet point exceeds 500 characters.' };
    }
  }
  // Weight is canonicalized to lbs (ticket #104, plan §6): an unparseable
  // weight omits the field instead of persisting raw text.
  const weightRaw = (input.weight ?? '').trim() || null;
  const weight = weightRaw !== null ? convertToLbs(weightRaw) : null;
  const dimensions = (input.dimensions ?? '').trim() || null;
  if (dimensions !== null && dimensions.length > 256) {
    return { ok: false, code: 'manual_field_invalid', reason: 'Manual dimensions exceed 256 characters.' };
  }
  const primaryImage = (input.primaryImage ?? '').trim() || null;
  if (primaryImage !== null && !isHttpUrl(primaryImage)) {
    return { ok: false, code: 'manual_field_invalid', reason: 'The manual primary image must be an http(s) URL.' };
  }
  const rawAdditional = input.additionalImages ?? [];
  if (!Array.isArray(rawAdditional)) {
    return { ok: false, code: 'manual_field_invalid', reason: 'Manual additional images must be an array of URLs.' };
  }
  const additionalImages = rawAdditional
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (additionalImages.length > 10) {
    return { ok: false, code: 'manual_field_invalid', reason: 'Manual evidence allows at most 10 additional images.' };
  }
  for (const imageUrl of additionalImages) {
    if (!isHttpUrl(imageUrl)) {
      return { ok: false, code: 'manual_field_invalid', reason: 'Every manual image must be an http(s) URL.' };
    }
  }
  // Per-field source kinds default to operator transcription. Unknown
  // fields and unknown kinds fail closed (the strict request schema
  // rejects unknown keys at HTTP; this guards direct service callers).
  const fieldSourcesInput = input.fieldSources ?? {};
  const fieldSources: Record<string, { sourceKind: 'operator_transcription' | 'packaging_photo' | 'distributor_sheet' | 'brand_family_reference' }> = {};
  for (const [field, kind] of Object.entries(fieldSourcesInput)) {
    if (!(MANUAL_EVIDENCE_FIELD_NAMES as readonly string[]).includes(field)) {
      return { ok: false, code: 'manual_field_invalid', reason: `Unknown manual-evidence field in fieldSources: '${field}'.` };
    }
    const parsedKind = ManualEvidenceSourceKindEnum.safeParse(kind);
    if (!parsedKind.success) {
      return { ok: false, code: 'manual_field_invalid', reason: `Invalid source kind for manual field '${field}'.` };
    }
    fieldSources[field] = { sourceKind: parsedKind.data };
  }
  // Per-image rights (ticket #104): every submitted image URL needs a
  // matching rights approval. A `distributor_sheet` source kind never
  // creates distributor linkage — linkage lives only in sourcing
  // generations/attempt ids, which this route never writes (the repo
  // throws when they are present on a manual row).
  const submittedImages = [...(primaryImage ? [primaryImage] : []), ...additionalImages];
  const imageApprovalsInput = input.imageApprovals ?? [];
  const approvedUrls = new Set(
    imageApprovalsInput
      .filter((entry) => entry && entry.rightsAttested === true && typeof entry.imageUrl === 'string')
      .map((entry) => entry.imageUrl.trim()),
  );
  for (const imageUrl of submittedImages) {
    if (!approvedUrls.has(imageUrl)) {
      return {
        ok: false,
        code: 'manual_image_rights_missing',
        reason: 'Every manual image requires a per-image rights approval before it can be submitted.',
      };
    }
  }
  const familyReferenceTextRaw = (input.familyReferenceText ?? '').trim() || null;
  if (familyReferenceTextRaw !== null && familyReferenceTextRaw.length > 8000) {
    return { ok: false, code: 'manual_field_invalid', reason: 'The family reference text exceeds 8000 characters.' };
  }
  const familyReferenceUrl = (input.familyReferenceUrl ?? '').trim() || null;
  if (familyReferenceUrl !== null && !isHttpUrl(familyReferenceUrl)) {
    return { ok: false, code: 'invalid_reference_url', reason: 'The family reference URL must be an http(s) URL.' };
  }
  const attestation = input.attestation;
  if (!attestation?.noFamilyInheritance || !attestation?.perSkuVerified || !attestation?.rightsAttested) {
    return {
      ok: false,
      code: 'manual_attestation_incomplete',
      reason: 'All three attestations (no family inheritance, per-SKU verified, image rights) are required.',
    };
  }

  const domain = resolveManualEvidenceDomain(
    { sourceUrl: item.sourceUrl, errorMessage: item.errorMessage },
    familyReferenceUrl,
  );
  if (domain !== null && deps.findProfileByDomain(domain) !== null) {
    return {
      ok: false,
      code: 'profile_now_healthy',
      reason: `An extractor profile is now usable for ${domain}; use profile retry instead of manual evidence.`,
    };
  }

  const distributorRow = findDistributorRecordExtraction(input.itemId);
  const overrideReason = (input.overrideDistributorReason ?? '').trim() || null;
  if (distributorRow && !overrideReason) {
    return {
      ok: false,
      code: 'distributor_record_exists',
      reason: 'A qualified distributor record already exists for this item; manual evidence requires an explicit override reason.',
    };
  }

  const operatorId = (input.operatorId ?? '').trim();
  if (!operatorId) {
    return { ok: false, code: 'manual_attestation_incomplete', reason: 'An operator id is required for manual evidence.' };
  }

  const identityStatus = deriveManualEvidenceIdentityStatus(familyReferenceUrl !== null);
  // Canonical field map shared with the gate hash check (ticket #104):
  // trimmed scalars, trimmed non-empty lists, populated fields only.
  const fieldValues = buildManualEvidenceFieldValues({
    title,
    brand,
    description,
    bulletPoints,
    weight,
    dimensions,
    primaryImage,
    additionalImages,
  });
  for (const field of Object.keys(fieldValues)) {
    if (!fieldSources[field]) fieldSources[field] = { sourceKind: 'operator_transcription' };
  }
  const notesParts: string[] = [];
  if ((attestation.notes ?? '').trim()) notesParts.push(attestation.notes!.trim());
  if (overrideReason) notesParts.push(`distributor override: ${overrideReason}`);

  try {
    return db.transaction(() => {
      const attestationRow = createManualEvidenceAttestation({
      itemId: input.itemId,
      batchId: item.batchId,
      operatorId,
      fieldValues,
      fieldSources,
      familyReferenceUrl,
      imageRights: submittedImages.map((imageUrl) => ({ imageUrl })),
      familyReferenceText: familyReferenceTextRaw,
      notes: notesParts.length > 0 ? notesParts.join('\n') : null,
    });
    const extractionData = ExtractionDataSchema.parse({
      sourceType: 'official_page',
      sourceUrl: null,
      confidence: 0,
      title,
      brand,
      description,
      bulletPoints,
      weight,
      dimensions,
      primaryImage,
      additionalImages,
      fieldProvenance: Object.fromEntries(Object.keys(fieldValues).map((field) => [field, 'user'])),
      identityStatus,
      identityReasons: [
        'operator manual transcription; family page is reference-only, not the extraction source',
      ],
      manualEvidenceAttestationId: attestationRow.attestation_id,
      manualReferenceUrl: familyReferenceUrl,
      packagingOcrData: null,
    });
    const extractionRow = insertExtraction({
      itemId: input.itemId,
      sourceType: 'official_page',
      sourceUrl: null,
      extractionMethod: MANUAL_EVIDENCE_METHOD,
      manualAttestationId: attestationRow.attestation_id,
      extractionDataJson: JSON.stringify(extractionData),
      confidence: 0,
    });
    const now = new Date().toISOString();
    const [extA, extB] = stagePredicateParams('collect_details');
    const updated = db.query(
      `UPDATE onboarding_items
       SET stage_status = 'completed', error_message = NULL, manual_reference_url = ?,
           extraction_data_json = ?, updated_at = ?
       WHERE id = ? AND (stage = ? OR stage = ?) AND stage_status = 'failed'`,
    ).run(familyReferenceUrl, JSON.stringify(extractionData), now, input.itemId, extA, extB);
    if (updated.changes === 0) {
      // A concurrent mutation won the race: the transaction rolls back
      // (attestation + extraction rows unwritten) and the caller retries.
      throw new Error('manual-evidence concurrent_state_change');
    }
      return {
        ok: true as const,
        attestationId: attestationRow.attestation_id,
        extractionId: extractionRow.id,
      };
    })();
  } catch (err) {
    if (err instanceof Error && err.message.includes('concurrent_state_change')) {
      return { ok: false, code: 'concurrent_state_change', reason: 'The item changed during submission; retry the manual evidence submission.' };
    }
    throw err;
  }
}

/**
 * Whether the item currently holds active manual evidence: its latest
 * extraction is the manual method with a non-superseded attestation.
 * Used by the profile-retry endpoint (ticket #105) to refuse resets that
 * would strand the extraction row + attestation and clobber operator work.
 */
export function hasActiveManualEvidence(itemId: string): boolean {
  const latest = getLatestExtraction(itemId);
  if (!latest || latest.extraction_method !== MANUAL_EVIDENCE_METHOD) return false;
  return getActiveManualEvidenceAttestationForItem(itemId) !== null;
}

/**
 * Operator withdrawal of manual evidence. Supersedes the active attestation,
 * removes the operator-created manual extraction row (the attestation row
 * preserves the audit trail), and restores the item to extraction/failed
 * with the profile-blocked signature so the automated path can retry.
 *
 * Deliberately NOT flag-gated (ticket #105 review P0-1): the kill-switch
 * must never strand active-manual items in a state that is neither
 * retryable (retry endpoint 409s withdraw-first) nor withdrawable.
 * Submission stays flag-gated; withdrawal only ever restores the prior
 * fail-closed blocked state, so it cannot create new manual evidence.
 */
export function withdrawManualEvidence(
  input: WithdrawManualEvidenceInput,
): WithdrawManualEvidenceResult {
  const item = findItemById(input.itemId);
  if (!item) {
    return { ok: false, code: 'item_not_found', reason: `Onboarding item ${input.itemId} not found.` };
  }
  const db = getDb();
  const batch = db
    .query('SELECT workspace_id FROM onboarding_batches WHERE id = ?')
    .get(item.batchId) as { workspace_id: string } | undefined;
  if (!batch || batch.workspace_id !== input.workspaceId) {
    return { ok: false, code: 'workspace_mismatch', reason: 'Item belongs to a different workspace.' };
  }
  const latest = getLatestExtraction(input.itemId);
  if (!latest || latest.extraction_method !== MANUAL_EVIDENCE_METHOD) {
    return { ok: false, code: 'no_manual_evidence_to_withdraw', reason: 'No manual evidence exists for this item.' };
  }
  const active = getActiveManualEvidenceAttestationForItem(input.itemId);
  if (!active) {
    return { ok: false, code: 'no_manual_evidence_to_withdraw', reason: 'No active manual attestation exists for this item.' };
  }
  const domain =
    resolveManualEvidenceDomain(
      { sourceUrl: item.sourceUrl, errorMessage: item.errorMessage },
      active.family_reference_url,
    ) ?? 'unknown domain';

  return db.transaction(() => {
    supersedeManualEvidenceAttestation(active.attestation_id);
    db.query(`DELETE FROM onboarding_extractions WHERE item_id = ? AND extraction_method = 'manual_evidence_v1'`).run(
      input.itemId,
    );
    const now = new Date().toISOString();
    db.query(
      `UPDATE onboarding_items
       SET stage = ?, stage_status = 'failed',
           error_message = ?, manual_reference_url = NULL, extraction_data_json = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(encodeForStorage('collect_details', readStorageVersion(db)), `No extractor profile for ${domain} (manual evidence withdrawn)`, now, input.itemId);
    return { ok: true as const, supersededAttestationId: active.attestation_id };
  })();
}
