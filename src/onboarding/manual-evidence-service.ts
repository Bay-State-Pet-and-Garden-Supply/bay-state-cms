import { getDb } from '../db/connection';
import { getManualEvidenceFlags } from './flags';
import { findItemById } from '../db/repositories/onboarding-item-repo';
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
 * Manual-evidence extraction route (parent #101, ticket #103 thin slice).
 *
 * The single audited operator path from `extraction/failed` (profile-blocked
 * or triaged family-page-only) to `extraction/completed`. Thin-slice field
 * set: title (required) + brand (optional). The family page URL is a
 * reference-only attachment — never the extraction source. The automated
 * worker never calls this module (no auto-degradation by construction:
 * every entry requires an explicit operator id + attestation).
 */

import { MANUAL_EVIDENCE_METHOD } from './manual-evidence-eligibility';

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

import {
  deriveManualEvidenceIdentityStatus,
  isManualEvidenceEligible,
  isManualEvidenceProfileBlockedError,
  resolveManualEvidenceDomain,
} from './manual-evidence-eligibility';

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
  if (item.stage === 'sourcing') {
    return {
      ok: false,
      code: 'sourcing_curation_bypass_rejected',
      reason: 'Manual evidence is never reachable from sourcing; sourcing items must go through discovery first.',
    };
  }
  if (item.stage === 'discovery') {
    return {
      ok: false,
      code: 'discovery_to_manual_rejected',
      reason: 'Discovery must resolve first; manual evidence is submitted from extraction.',
    };
  }
  if (item.stage !== 'extraction') {
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
  if (item.stage === 'extraction' && item.stageStatus === 'completed') {
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
  const fieldValues: Record<string, unknown> = { title };
  if (brand !== null) fieldValues.brand = brand;
  const fieldSources: Record<string, { sourceKind: 'operator_transcription'; referenceUrl?: string | null }> = {
    title: { sourceKind: 'operator_transcription' },
  };
  if (brand !== null) fieldSources.brand = { sourceKind: 'operator_transcription' };
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
      notes: notesParts.length > 0 ? notesParts.join('\n') : null,
    });
    const extractionData = ExtractionDataSchema.parse({
      sourceType: 'official_page',
      sourceUrl: null,
      confidence: 0,
      title,
      brand,
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
    const updated = db.query(
      `UPDATE onboarding_items
       SET stage_status = 'completed', error_message = NULL, manual_reference_url = ?,
           extraction_data_json = ?, updated_at = ?
       WHERE id = ? AND stage = 'extraction' AND stage_status = 'failed'`,
    ).run(familyReferenceUrl, JSON.stringify(extractionData), now, input.itemId);
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
 * Operator withdrawal of manual evidence. Supersedes the active attestation,
 * removes the operator-created manual extraction row (the attestation row
 * preserves the audit trail), and restores the item to extraction/failed
 * with the profile-blocked signature so the automated path can retry.
 */
export function withdrawManualEvidence(
  input: WithdrawManualEvidenceInput,
): WithdrawManualEvidenceResult {
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
       SET stage = 'extraction', stage_status = 'failed',
           error_message = ?, manual_reference_url = NULL, extraction_data_json = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(`No extractor profile for ${domain} (manual evidence withdrawn)`, now, input.itemId);
    return { ok: true as const, supersededAttestationId: active.attestation_id };
  })();
}
