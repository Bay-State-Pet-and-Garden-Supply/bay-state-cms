/**
 * Manual-evidence eligibility helpers (parent #101, ticket #103 thin slice).
 *
 * Pure, dependency-free helpers so the vitest unit lane can cover the
 * fail-closed entry contract without loading bun:sqlite. The audited service
 * (`manual-evidence-service.ts`) reuses these exact helpers — one definition,
 * two lanes.
 */

import { toCanonicalStage } from '../shared/onboarding-stage-vocabulary';

/** Slice 5b native: canonical extraction-stage check (either spelling). */
function isManualEvidenceStage(rawStage: unknown): boolean {
  try {
    return toCanonicalStage(rawStage) === 'collect_details';
  } catch {
    return false;
  }
}

const PROFILE_BLOCKED_RE = /^No extractor profile for\s+(\S+)/i;

export const MANUAL_EVIDENCE_METHOD = 'manual_evidence_v1' as const;

/**
 * Stable reject code for the profile-retry endpoint (parent #101, ticket
 * #105 hardening): resetting a manual-completed item to pending would
 * strand its extraction row + active attestation and silently clobber
 * operator work. The retry endpoint refuses with this code and directs
 * the operator to withdraw first; withdraw-then-retry per item still works.
 */
export const MANUAL_EVIDENCE_ACTIVE_RETRY_CODE = 'manual_evidence_active_retry_rejected' as const;

/**
 * Full manual fact set (parent #101, ticket #104). The canonical per-field
 * keys for operator-transcribed manual evidence. The request schema, the
 * submit service, the attestation checklist, and the review-gate hash check
 * all derive from this one tuple — a single spelling per concept.
 */
export const MANUAL_EVIDENCE_FIELD_NAMES = [
  'title',
  'brand',
  'description',
  'bulletPoints',
  'weight',
  'dimensions',
  'primaryImage',
  'additionalImages',
] as const;

export type ManualEvidenceFieldName = (typeof MANUAL_EVIDENCE_FIELD_NAMES)[number];

/** Raw per-field values for one manual-evidence submission (pre-canonicalization). */
export interface ManualEvidenceFieldPayload {
  title?: string | null;
  brand?: string | null;
  description?: string | null;
  bulletPoints?: string[] | null;
  weight?: string | null;
  dimensions?: string | null;
  primaryImage?: string | null;
  additionalImages?: string[] | null;
}

function canonicalScalar(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function canonicalStringList(values: string[] | null | undefined): string[] | null {
  if (!Array.isArray(values)) return null;
  const cleaned = values
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Canonical per-field value map for one manual-evidence submission.
 *
 * The SAME builder runs at submit time (checklist + value hashes) and at
 * gate time (rebuilt from the stored extraction payload for the hash-match
 * check), so the two always agree: trimmed scalars, trimmed non-empty
 * string lists, populated fields only. Pure — DB-free.
 */
export function buildManualEvidenceFieldValues(
  payload: ManualEvidenceFieldPayload,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of MANUAL_EVIDENCE_FIELD_NAMES) {
    if (field === 'bulletPoints' || field === 'additionalImages') {
      const list = canonicalStringList(payload[field]);
      if (list !== null) out[field] = list;
      continue;
    }
    const scalar = canonicalScalar(payload[field]);
    if (scalar !== null) out[field] = scalar;
  }
  return out;
}

/** Normalize operator text for comparison: trim, collapse whitespace, casefold. */
export function normalizeManualEvidenceText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Minimum normalized value length for the containment arm of the
 * inheritance check. Short values ("Treats", "Beef") appear on family
 * pages by coincidence; only non-trivial copied spans fire. Normalized
 * equality fires at any length.
 */
export const MANUAL_EVIDENCE_INHERITANCE_CONTAINMENT_MIN_LENGTH = 24;

/**
 * Family-inheritance suspicion (parent #101, ticket #104).
 *
 * True when a manual field value, normalized, either EQUALS the stored
 * family-reference snapshot text or — for non-trivial values — is CONTAINED
 * in it. The snapshot is operator-pasted reference text stored at submit
 * time; the gate never fetches the network. Pure — DB-free.
 */
export function isManualFieldValueInherited(
  fieldValue: string | null | undefined,
  snapshotText: string | null | undefined,
): boolean {
  if (typeof fieldValue !== 'string' || typeof snapshotText !== 'string') return false;
  const normalizedValue = normalizeManualEvidenceText(fieldValue);
  const normalizedSnapshot = normalizeManualEvidenceText(snapshotText);
  if (!normalizedValue || !normalizedSnapshot) return false;
  if (normalizedValue === normalizedSnapshot) return true;
  return (
    normalizedValue.length >= MANUAL_EVIDENCE_INHERITANCE_CONTAINMENT_MIN_LENGTH &&
    normalizedSnapshot.includes(normalizedValue)
  );
}

/** True when the failure message is the worker's missing-profile signature. */
export function isManualEvidenceProfileBlockedError(errorMessage: string | null | undefined): boolean {
  if (!errorMessage) return false;
  return PROFILE_BLOCKED_RE.test(errorMessage);
}

/** Manual identity is never stronger than parent-only / insufficient-evidence. */
export function deriveManualEvidenceIdentityStatus(
  hasFamilyReference: boolean,
): 'parent_product_only' | 'insufficient_evidence' {
  return hasFamilyReference ? 'parent_product_only' : 'insufficient_evidence';
}

export interface ManualEvidenceEligibilityInput {
  stage: string;
  stageStatus: string;
  errorMessage: string | null | undefined;
  familyPageOnlyConfirmed: boolean;
}

/**
 * Pure eligibility check: only `collect_details/failed` items whose failure is
 * either the profile-blocked signature or an explicitly triaged
 * family-page-only failure may enter the manual route. Slice 5b native:
 * accepts either stored spelling (dual read).
 */
export function isManualEvidenceEligible(input: ManualEvidenceEligibilityInput): boolean {
  if (!isManualEvidenceStage(input.stage)) return false;
  if (input.stageStatus !== 'failed') return false;
  if (isManualEvidenceProfileBlockedError(input.errorMessage)) return true;
  return input.familyPageOnlyConfirmed;
}

export interface ManualEvidenceDomainInput {
  sourceUrl: string | null | undefined;
  errorMessage: string | null | undefined;
}

/**
 * Resolve the brand domain for the submit-time healthy-profile re-check.
 * Prefers the item source URL host, then the family reference host, then the
 * profile-blocked error token. Null when no domain can be resolved (triage
 * path without URLs — the operator confirmation stands in for the check).
 */
export function resolveManualEvidenceDomain(
  item: ManualEvidenceDomainInput,
  familyReferenceUrl: string | null | undefined,
): string | null {
  const fromUrl = (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    try {
      const host = new URL(raw).hostname.trim().toLowerCase();
      return host || null;
    } catch {
      return null;
    }
  };
  const fromError =
    PROFILE_BLOCKED_RE.exec(item.errorMessage ?? '')?.[1]
      ?.toLowerCase()
      ?.replace(/^www\./, '')
      ?.split('/')[0]
      ?.split(':')[0]
      ?.trim() || null;
  return fromUrl(item.sourceUrl) ?? fromUrl(familyReferenceUrl) ?? fromError;
}
