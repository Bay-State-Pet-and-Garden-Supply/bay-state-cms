// fallow-ignore-file unused-export

/**
 * Shared Page-proposal display helpers (issue #17 D1 contract).
 *
 * A `category_page` proposal's identity is the stable Page ID; its display
 * name is data (`proposedValue.pageName`). Legacy proposals stored the name in
 * `proposedValue` (string) with the name also in `targetId`. Every consumer —
 * preview, promotion, benchmark, retrieval, and the review UI — must read the
 * display name through these helpers and never place a Page ID into a
 * page-name field.
 */
export interface PageProposalLike {
  proposedValue?: unknown;
  targetId?: string | null;
  revisedValue?: unknown;
  hasRevisedValue?: boolean;
  revisedTargetId?: string | null;
  hasRevisedTargetId?: boolean;
}

/**
 * Page display name from a category_page effective value.
 *
 * New shape: `{ pageId, pageName, identityVerified }` — the display name is
 * `pageName`. Legacy shape: the value itself is the page name string.
 *
 * Returns `null` (NEVER a Page ID) when no display name is present. The
 * target/identity ID is deliberately not consulted: for new proposals the
 * target is the stable Page ID, so falling back to it would place an identity
 * into a page-name field.
 */
export function pageNameFromPageValue(value: unknown): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const pageName = (value as Record<string, unknown>).pageName;
    if (typeof pageName === 'string' && pageName.trim().length > 0) return pageName;
    // An object without a valid pageName has no display name; the caller must
    // handle null (skip/visible-unavailable) — never substitute the identity.
    return null;
  }
  if (typeof value === 'string' && value.trim().length > 0) return value;
  return null;
}

/**
 * Display name for a category_page proposal, honoring the reviewed correction
 * when present (same precedence as `getEffectiveProposalValue`). Never returns
 * a Page ID — only `pageName` (new shape) or a legacy string value.
 */
export function getPageDisplayName(proposal: PageProposalLike): string | null {
  const effective = proposal.hasRevisedValue ? proposal.revisedValue : proposal.proposedValue;
  return pageNameFromPageValue(effective);
}

/**
 * Stable Page identity for a category_page proposal. Returns the reviewed or
 * proposed `pageId` when present, else `null` (legacy name-only proposals
 * have no verified identity and must never be treated as verified).
 */
export function getPageIdentityId(proposal: PageProposalLike): string | null {
  const effective = proposal.hasRevisedValue ? proposal.revisedValue : proposal.proposedValue;
  if (effective && typeof effective === 'object' && !Array.isArray(effective)) {
    const pageId = (effective as Record<string, unknown>).pageId;
    if (typeof pageId === 'string' && pageId.length > 0) return pageId;
  }
  return null;
}

/**
 * True when a row carries explicit reviewed removal intent (issue #353):
 * the correction sets a null value (`hasRevisedValue && revisedValue ===
 * null`). Covers both the value-clear shape (field keeps its target, value
 * empties) and the full-clear shape (target also nulled). Works on proposals
 * and live decisions alike (both carry the same presence-flag fields).
 */
export function isRemovalIntent(row: {
  hasRevisedValue?: boolean;
  revisedValue?: unknown;
}): boolean {
  return row.hasRevisedValue === true && row.revisedValue === null;
}
