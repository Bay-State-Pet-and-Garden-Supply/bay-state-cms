/**
 * Issue #218 — variant-identity rollout hold as a runtime predicate.
 *
 * Template pages whose evidence cannot enforce variant identity (the
 * Nylabone Sitecore precedent: size-bearing family pages where the worker
 * parses no variant matrix, so no selector can discriminate sizes) must
 * not release size-specific items automatically. The prior per-brand
 * `selectiveReleaseEligibility20*` predicates are evidence records that are
 * explicitly NOT wired as release gates on their own — this module is the
 * single runtime predicate the release paths filter on instead.
 *
 * Eligibility is derived from durable per-item state only:
 * - an error message parked by the variant gate (`variant:…`, written by
 *   the worker when extraction cannot prove single-variant identity,
 *   including the no-matrix Sitecore case where no resolution row exists);
 * - the current `onboarding_variant_resolutions` row: only `selected`
 *   (operator-chosen) and `resolved` (automatic exact-identifier match)
 *   prove variant identity. Every other status (`ambiguous`, `no_match`,
 *   `stale`, `unsupported`, `too_many_variants`, …) — or a missing
 *   selected key on an otherwise resolved row — waits for operator variant
 *   selection by construction.
 * - an explicit unresolved variant-identity disposition
 *   (`variant-identity-disposition-repo`, value
 *   `unresolved_variant_identity`): operator/brand-curation knowledge that
 *   a size-specific item sits on a variant-bearing page no matrix
 *   enforces — e.g. a Nylabone row parked as profile-blocked with neither
 *   of the two signals above. A proven `selected`/`resolved` selection
 *   still releases (positive proof wins); otherwise the item waits.
 *
 * Items with none of the three signals (single-variant pages,
 * family-level items with no variant bearing and no recorded disposition)
 * are identifiable and eligible.
 */

export const VARIANT_INELIGIBILITY_REASON_PREFIX = 'variant_resolution_required';

/**
 * Explicit unresolved variant-identity disposition value. Persisted per item
 * by `variant-identity-disposition-repo` for variant-bearing pages where no
 * matrix enforces identity (the Nylabone Sitecore precedent: size-specific
 * rows parked as profile-blocked with neither a resolution row nor a
 * `variant:` gate error). Defined here — next to the predicate that
 * consults it — so the pure eligibility module stays dependency-free.
 */
export const UNRESOLVED_VARIANT_IDENTITY_DISPOSITION = 'unresolved_variant_identity';

/** Minimal variant-resolution view the predicate consults (DB row subset). */
export interface VariantIdentityResolutionView {
  status: string;
  selected_variant_key?: string | null;
  automatic_variant_key?: string | null;
}

export interface VariantIdentityEligibilityInput {
  itemId: string;
  /** Current `error_message` on the blocked extraction row (may be null). */
  errorMessage?: string | null;
  /** Current (non-superseded) variant resolution row, if any. */
  variantResolution?: VariantIdentityResolutionView | null;
  /**
   * Explicit unresolved variant-identity disposition for the item, if any.
   * Holds the item even with a profile-blocked (non-variant) error and no
   * resolution row. A proven operator/automatic selection (above) still
   * releases — positive proof wins over the recorded absence of proof.
   */
  variantDisposition?: { disposition: string; reason?: string | null } | null;
}

export interface VariantIdentityEligibility {
  eligible: boolean;
  reason: string;
}

/** True when the error text proves the variant gate parked this item. */
function isVariantGateError(errorMessage?: string | null): boolean {
  return /variant:/i.test(errorMessage ?? '');
}

/** True when an explicit unresolved variant-identity disposition is recorded. */
function hasUnresolvedVariantDisposition(disposition?: { disposition: string } | null): boolean {
  return (disposition?.disposition ?? '') === UNRESOLVED_VARIANT_IDENTITY_DISPOSITION;
}

/**
 * Runtime variant-identity eligibility for one blocked extraction item.
 * Fail-closed: any variant-bearing signal without a proven selection is
 * ineligible with a clear `variant_resolution_required` reason.
 */
export function variantIdentityEligibilityForItem(
  input: VariantIdentityEligibilityInput,
): VariantIdentityEligibility {
  const resolution = input.variantResolution ?? null;
  if (resolution) {
    const status = (resolution.status ?? '').toLowerCase();
    if (status === 'selected') {
      if (resolution.selected_variant_key) {
        return { eligible: true, reason: 'eligible: operator-selected variant identity' };
      }
      return {
        eligible: false,
        reason: `${VARIANT_INELIGIBILITY_REASON_PREFIX}: variant resolution is selected but carries no selected variant key (item ${input.itemId})`,
      };
    }
    if (status === 'resolved') {
      if (resolution.selected_variant_key || resolution.automatic_variant_key) {
        return { eligible: true, reason: 'eligible: automatically resolved variant identity' };
      }
      return {
        eligible: false,
        reason: `${VARIANT_INELIGIBILITY_REASON_PREFIX}: variant resolution is resolved but carries no variant key (item ${input.itemId})`,
      };
    }
    return {
      eligible: false,
      reason: `${VARIANT_INELIGIBILITY_REASON_PREFIX}: variant resolution is ${resolution.status} — operator variant selection required first (item ${input.itemId})`,
    };
  }
  if (isVariantGateError(input.errorMessage)) {
    return {
      eligible: false,
      reason: `${VARIANT_INELIGIBILITY_REASON_PREFIX}: variant gate parked this item and no variant matrix enforces identity — operator variant selection required first (item ${input.itemId})`,
    };
  }
  // No-matrix Sitecore case: a size-specific item parked as profile-blocked
  // carries neither a resolution row nor a variant gate error, so the two
  // checks above pass it. The explicit persisted disposition closes that
  // gap — fail closed until operator variant selection proves identity.
  if (hasUnresolvedVariantDisposition(input.variantDisposition)) {
    return {
      eligible: false,
      reason: `${VARIANT_INELIGIBILITY_REASON_PREFIX}: explicit unresolved variant-identity disposition${input.variantDisposition?.reason ? ` (${input.variantDisposition.reason})` : ''} — operator variant selection required first (item ${input.itemId})`,
    };
  }
  return { eligible: true, reason: 'eligible: no variant-identity hold' };
}
