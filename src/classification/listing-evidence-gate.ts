/**
 * Listing-Evidence Single Gate Evaluator (issue #366).
 *
 * ONE server-owned verdict/currentness interpretation reused at review
 * completion, durable approval, draft creation, change-set approval, package
 * export, and direct push. Every release path calls
 * `evaluateListingEvidenceGate` — never a re-derivation, never a UI-only
 * guard.
 *
 * Gate semantics (fail closed):
 * - No record (legacy rows, never evaluated) → grandfathered pass with a
 *   `no_record` code. New evaluations always write a record, so absence
 *   means pre-feature, not evasion.
 * - Record present: strict-parse against the EXACT shared schema. Malformed
 *   → block (`listing_evidence_malformed`).
 * - A record WITHOUT the version marker is treated as malformed (fail
 *   closed): only absense grandfathers, never a stripped record.
 * - listingHash must equal the CURRENT final listing hash, evidenceHash the
 *   CURRENT eligible bundle hash, rulesVersion the CURRENT rules version,
 *   modelPolicyDigest the CURRENT policy digest. Any drift → stale block
 *   (`listing_evidence_stale`): consequential text/evidence/rule changes
 *   invalidate affected findings and approvals rather than relying on UI.
 * - status `blocked` (any included unsupported/contradicted material claim)
 *   → block. `unavailable` (service failure/overflow/incomplete) →
 *   block — failure, incomplete responses, uncertainty, or overflow never
 *   produce a partial all-clear. `needs_review` → block until resolved.
 * - `passed` → release allowed.
 * - Distributor-record items: same gate over their read-only materialized
 *   evidence; Extraction tamper/divergence keeps its existing refusal
 *   (this gate never repairs it).
 */
import {
  ListingEvidenceValidationSchema,
  type ListingEvidenceValidation,
  type ReviewCompletenessBlockerCode,
} from '../shared/schemas/onboarding';
import { LISTING_EVIDENCE_RULES_VERSION } from './listing-evidence';

export interface ListingEvidenceGateInput {
  /** Parsed curationData (or null when absent). */
  curationData: Record<string, unknown> | null;
  /** Current final-listing hash (recomputed from the live projection). */
  currentListingHash: string;
  /** Current eligible evidence-bundle hash. */
  currentEvidenceHash: string;
  /**
   * Current model-policy digest. Callers on release paths MUST supply live
   * context so this is a real digest (or the literal
   * `'policy_unavailable'` when policy is disabled/unreadable); fail-closed
   * means an unavailable current policy is compared strictly, never
   * skipped. A legacy `''` (advisory calls with no context) keeps the leg
   * inert so old callers cannot false-block.
   */
  currentModelPolicyDigest: string;
  /**
   * Current configured requiredness (sorted). Compared strictly when
   * supplied: an optional→required flip since evaluation is stale even
   * when the prose hash is unchanged. Callers that already hash
   * requiredness into the listing hash may omit this (the hash leg
   * covers them); frozen-artifact callers SHOULD supply it so a
   * requiredness-only change refuses with an explicit reason.
   */
  currentRequiredFields?: string[];
  /**
   * Current selected-source authority (W2B367 stamps it on the record).
   * Compared strictly when both sides present: a source change that leaves
   * text hashes unchanged still stales the record. Absent on either side
   * grandfathers (pre-authority records).
   */
  currentSourceAuthority?: string;
}

/** Blocker code contributed to Review completeness when the gate refuses. */
export const LISTING_EVIDENCE_BLOCKER: ReviewCompletenessBlockerCode = 'listing_evidence_unresolved';
/** Result of the single listing-evidence gate evaluation. */
export type ListingEvidenceGateResult =
  | { ok: true; status: 'passed' }
  | { ok: false; code: 'listing_evidence_malformed' | 'listing_evidence_stale' | 'listing_evidence_unresolved'; reason: string };

/**
 * Pure single gate evaluator. Deterministic; no DB access. Callers supply
 * the CURRENT hashes; this function interprets the persisted record.
 */
export function evaluateListingEvidenceGate(input: ListingEvidenceGateInput): ListingEvidenceGateResult {
  const raw = input.curationData?.listingEvidenceValidation;
  if (raw === undefined || raw === null) {
    return { ok: true, status: 'passed' };
  }
  if (typeof raw !== 'object' || (raw as Record<string, unknown>).recordVersion === undefined) {
    return {
      ok: false,
      code: 'listing_evidence_malformed',
      reason: 'The persisted listing-evidence record is malformed; re-run the listing check before release.',
    };
  }
  const parsed = ListingEvidenceValidationSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'listing_evidence_malformed',
      reason: 'The persisted listing-evidence record is malformed; re-run the listing check before release.',
    };
  }
  const record: ListingEvidenceValidation = parsed.data;

  if (record.rulesVersion !== LISTING_EVIDENCE_RULES_VERSION) {
    return {
      ok: false,
      code: 'listing_evidence_stale',
      reason: 'Listing-evidence rules changed since evaluation; re-run the listing check before release.',
    };
  }
  if (record.listingHash !== input.currentListingHash) {
    return {
      ok: false,
      code: 'listing_evidence_stale',
      reason: 'The listing changed since evidence evaluation; re-run the listing check before release.',
    };
  }
  if (record.evidenceHash !== input.currentEvidenceHash) {
    return {
      ok: false,
      code: 'listing_evidence_stale',
      reason: 'The evidence bundle changed since evaluation; re-run the listing check before release.',
    };
  }
  // Gap 5: policy is compared STRICTLY. A stamped digest must equal the
  // live digest — including the literal 'policy_unavailable' when policy
  // is disabled/unreadable (policy removal/rotation stales the record).
  // Only a legacy '' current digest (advisory caller with no workspace
  // context) keeps the leg inert.
  if (input.currentModelPolicyDigest !== '') {
    if (record.modelPolicyDigest !== input.currentModelPolicyDigest) {
      return {
        ok: false,
        code: 'listing_evidence_stale',
        reason: 'Model policy changed (or became unavailable) since evaluation; re-run the listing check before release.',
      };
    }
  }
  // Gap 6: requiredness is compared explicitly when the caller supplies
  // it (belt-and-braces over the hash leg: a requiredness-only change
  // that somehow kept the prose hash refuses with an explicit reason).
  if (input.currentRequiredFields !== undefined && input.currentRequiredFields.length > 0) {
    const stamped = [...record.requiredFields].sort().join('\0');
    const live = [...input.currentRequiredFields].sort().join('\0');
    if (stamped !== live && stamped !== '') {
      return {
        ok: false,
        code: 'listing_evidence_stale',
        reason: 'Required listing fields changed since evaluation; re-run the listing check before release.',
      };
    }
  }
  // Source-authority leg (W2B367 stamps `sourceAuthority` on the record):
  // present-on-both-sides mismatch is stale; absence on either side
  // grandfathers pre-authority records.
  if (input.currentSourceAuthority !== undefined && input.currentSourceAuthority !== '') {
    const rawRecord: unknown = record;
    const stampedAuthority = rawRecord !== null && typeof rawRecord === 'object' && 'sourceAuthority' in rawRecord
      ? rawRecord.sourceAuthority
      : undefined;
    if (typeof stampedAuthority === 'string' && stampedAuthority !== '' && stampedAuthority !== input.currentSourceAuthority) {
      return {
        ok: false,
        code: 'listing_evidence_stale',
        reason: 'The selected source changed since evaluation; re-run the listing check before release.',
      };
    }
  }

  switch (record.status) {
    case 'passed':
      return { ok: true, status: 'passed' };
    case 'blocked': {
      const first = record.findings[0] ?? 'An included listing claim is unsupported or contradicted.';
      return { ok: false, code: 'listing_evidence_unresolved', reason: first };
    }
    case 'needs_review': {
      const first = record.findings[0] ?? 'Listing claims need review before release.';
      return { ok: false, code: 'listing_evidence_unresolved', reason: first };
    }
    case 'unavailable':
      return {
        ok: false,
        code: 'listing_evidence_unresolved',
        reason: 'Listing-evidence evaluation is unavailable (failure, overflow, or oversized claim); resolve before release.',
      };
    case 'stale':
      return {
        ok: false,
        code: 'listing_evidence_stale',
        reason: 'Listing-evidence evaluation is stale; re-run the listing check before release.',
      };
    default:
      return {
        ok: false,
        code: 'listing_evidence_malformed',
        reason: 'The persisted listing-evidence record carries an unknown status; re-run the listing check.',
      };
  }
}

/**
 * Currentness inputs for one onboarding item: recompute the final-listing
 * hash and eligible bundle hash so hash mismatch fails closed.
 */
export function currentnessMatches(
  record: ListingEvidenceValidation,
  current: { listingHash: string; evidenceHash: string },
): boolean {
  return record.listingHash === current.listingHash && record.evidenceHash === current.evidenceHash;
}
