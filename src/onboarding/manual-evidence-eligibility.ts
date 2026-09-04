/**
 * Manual-evidence eligibility helpers (parent #101, ticket #103 thin slice).
 *
 * Pure, dependency-free helpers so the vitest unit lane can cover the
 * fail-closed entry contract without loading bun:sqlite. The audited service
 * (`manual-evidence-service.ts`) reuses these exact helpers — one definition,
 * two lanes.
 */

const PROFILE_BLOCKED_RE = /^No extractor profile for\s+(\S+)/i;

export const MANUAL_EVIDENCE_METHOD = 'manual_evidence_v1' as const;

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
 * Pure eligibility check: only `extraction/failed` items whose failure is
 * either the profile-blocked signature or an explicitly triaged
 * family-page-only failure may enter the manual route.
 */
export function isManualEvidenceEligible(input: ManualEvidenceEligibilityInput): boolean {
  if (input.stage !== 'extraction') return false;
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
