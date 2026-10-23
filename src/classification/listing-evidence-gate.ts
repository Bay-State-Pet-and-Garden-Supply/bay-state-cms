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
import type { ItemChecklistEvaluation } from '../shared/schemas/item-evidence';

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
   * Current accepted-snapshot authority hash. Compared strictly with the
   * accepted authority bound into the record, so source-state drift cannot
   * survive merely because evaluated prose is unchanged.
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
  if (input.currentRequiredFields !== undefined) {
    const stamped = [...record.requiredFields].sort().join('\0');
    const live = [...input.currentRequiredFields].sort().join('\0');
    if (stamped !== live) {
      return {
        ok: false,
        code: 'listing_evidence_stale',
        reason: 'Required listing fields changed since evaluation; re-run the listing check before release.',
      };
    }
  }
  // When a live accepted-snapshot authority is supplied, it must be present
  // and identical in the record. Missing/stale accepted evidence never
  // falls through to legacy raw-source authority.
  if (input.currentSourceAuthority !== undefined) {
    const stampedAuthority = 'sourceAuthority' in record ? record.sourceAuthority : undefined;
    if (!input.currentSourceAuthority || stampedAuthority !== input.currentSourceAuthority) {
      return {
        ok: false,
        code: 'listing_evidence_stale',
        reason: 'The accepted evidence authority changed or is unavailable; re-run the listing check before release.',
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

export type ListingCompletenessGateResult =
  | { ok: true; status: 'ready' }
  | { ok: false; code: 'listing_completeness_unavailable' | 'listing_completeness_stale' | 'listing_completeness_unresolved'; reason: string };

/** One fail-closed interpretation of the shared item checklist for release callers. */
export function evaluateListingCompletenessGate(
  evaluation: ItemChecklistEvaluation | null,
): ListingCompletenessGateResult {
  if (!evaluation || evaluation.status === 'unavailable') {
    return { ok: false, code: 'listing_completeness_unavailable', reason: 'Current listing completeness could not be evaluated.' };
  }
  if (evaluation.status === 'stale' || !evaluation.inputHash || !evaluation.evidenceHash ||
      !evaluation.standardHash || !evaluation.classificationHash || !evaluation.listingHash) {
    return { ok: false, code: 'listing_completeness_stale', reason: 'Listing completeness is stale or lacks required currentness hashes.' };
  }
  if (evaluation.status !== 'ready' || evaluation.requirements.some(requirement =>
    requirement.required && !['satisfied', 'not_applicable', 'excepted'].includes(requirement.state),
  )) {
    return { ok: false, code: 'listing_completeness_unresolved', reason: evaluation.reasons[0] ?? 'Required listing requirements remain unresolved.' };
  }
  return { ok: true, status: 'ready' };
}
