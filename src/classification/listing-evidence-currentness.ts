/**
 * Listing-Evidence Currentness (issue #366).
 *
 * Recomputes CURRENT final-listing + evidence-bundle hashes from LIVE
 * item/curation/evidence state so the single gate evaluator can detect
 * consequential edits via hash mismatch. Shared by review completion,
 * durable approval, draft creation, change-set approval, export, and push.
 *
 * Read-only: never mutates. Fail-open hashes are forbidden — when live
 * state is unreadable the hashes are empty strings, which mismatch any
 * real record (fail closed) and pass only when no record exists
 * (grandfather path handles absence before comparing).
 */
import { findItemById, findCurationDataJsonById } from '../db/repositories/onboarding-item-repo';
import { findWorkspace } from '../db/repositories/workspace-repo';
import { getEvidenceByRun } from '../db/repositories/classification-run-repo';
import { blockingPreparationFields } from '../db/repositories/preparation-gap-repo';
import {
  buildClaimUnits,
  deterministicClaimCheck,
  eligibleEvidenceFor,
  hashEvidenceBundle,
  hashFinalListing,
  type BuiltClaim,
  type EligibleEvidence,
  type FinalListingInput,
} from './listing-evidence';
import { captureModelPolicySnapshot } from '../onboarding/model-policy-snapshot';

export interface ListingEvidenceCurrentHashes {
  listingHash: string;
  evidenceHash: string;
  modelPolicyDigest: string;
  /** Canonical selected-source authority bound into listingHash (issue #367).
   * A `PUT /items/:id` change to `source_url` stales the record; empty only
   * when the item row is unreadable (fail-closed mismatch).
   */
  sourceAuthority: string;
}

/** Frozen draft projection being released (title/description/variantFacts). */
export interface DraftListingProjection {
  title: string | null;
  description: string | null;
  variantFacts: Record<string, string>;
}

/** Hashes for a frozen draft artifact (change-set gate compares the record against the draft). */
export interface DraftListingHashes {
  listingHash: string;
  evidenceHash: string;
  modelPolicyDigest: string;
  requiredFields: string[];
}

/** Parse a JSON blob to a string record (null when unusable). */
function asRecord(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(String(raw));
    if (!value || typeof value !== 'object') return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Intentional-absence sentinel (issue #366 gap 2): writing this exact value
 * to `curatedTitle`/`curatedDescription` means "the operator removed this
 * field on purpose" — distinct from null/omitted (never set) which falls
 * back to extraction text. Every projection below honors it: a removed
 * field projects to null with NO extraction fallback, so removal cannot
 * resurrect fallback copy and stays stable through re-run, currentness,
 * draft promotion, and release hashing.
 */
export const LISTING_EVIDENCE_REMOVED = '__listing_evidence_removed__';

/** True when a curated value is the intentional-absence sentinel. */
export function isListingEvidenceRemoved(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === LISTING_EVIDENCE_REMOVED;
}

/**
 * Projected curated string honoring intentional absence: sentinel → null
 * with `removed: true` (caller must NOT fall back to extraction);
 * non-empty text → the text; anything else → null with `removed: false`
 * (caller falls back to extraction as before).
 */
export function projectedCuratedString(value: unknown): { text: string | null; removed: boolean } {
  if (isListingEvidenceRemoved(value)) return { text: null, removed: true };
  return { text: readString(value), removed: false };
}

/**
 * Current model-policy digest for the gate. Callers that hold live policy
 * context (workspace path/id) pass it explicitly so rotation invalidates
 * the record. When workspace context IS supplied but policy is
 * disabled/unreadable, returns the literal `'policy_unavailable'` (which
 * the service stamps at evaluation time) so removal/rotation stales the
 * record instead of disabling the check. Returns `''` only when NO
 * workspace context is available (advisory path — digest leg inert).
 * Never throws.
 */
export function currentPolicyDigestFor(workspacePath?: string, workspaceId?: string): string {
  let resolvedPath = workspacePath;
  if (!resolvedPath && workspaceId) {
    try {
      const active = findWorkspace();
      if (active && active.id === workspaceId) resolvedPath = active.workspacePath;
    } catch {
      // fall through to inert leg below
    }
  }
  if (!resolvedPath) return '';
  try {
    const snapshot = captureModelPolicySnapshot(resolvedPath, undefined, workspaceId);
    if (snapshot.state === 'configured') return snapshot.view.policyDigest;
  } catch {
    // Policy unreadable: fall through to unavailable below.
  }
  return 'policy_unavailable';
}

/** Canonical selected-source authority for one item (issue #367 gap 5).
 * `distributor_record` items bind `distributor:<upc>` (source_url stays NULL
 * by Amendment A); official-page items bind the canonical lowercased
 * `official:<url>` (or `official:unselected` when no URL is selected yet).
 * A `PUT /items/:id` source change therefore changes this string, and the
 * verify revision + gate comparisons below go stale. Empty only when the
 * item row is unreadable (fail-closed mismatch). Pure read of the live row.
 */
export function currentSourceAuthority(itemId: string): string {
  try {
    const item = findItemById(itemId);
    if (!item) return '';
    if (item.sourceType === 'distributor_record') return `distributor:${item.upc}`;
    const raw = typeof item.sourceUrl === 'string' ? item.sourceUrl.trim() : '';
    if (!raw) return 'official:unselected';
    return `official:${raw.toLowerCase()}`;
  } catch {
    return '';
  }
}
export function currentListingEvidenceHashes(
  itemId: string,
  parsedCuration?: Record<string, unknown> | null,
  policyContext?: { workspacePath?: string; workspaceId?: string },
): ListingEvidenceCurrentHashes {
  const empty: ListingEvidenceCurrentHashes = { listingHash: '', evidenceHash: '', modelPolicyDigest: '', sourceAuthority: '' };
  const item = findItemById(itemId);
  if (!item) return empty;
  // (row loaded above; `item` here is the live row — authority binds it)
  const sourceAuthority = currentSourceAuthority(itemId);
  const curation = parsedCuration ?? asRecord(findCurationDataJsonById(itemId) ?? null) ?? {};
  const extraction = asRecord(
    typeof item.extractionData === 'string'
      ? item.extractionData
      : JSON.stringify(item.extractionData ?? {}),
  ) ?? {};
  const curationTitleSlot = projectedCuratedString(curation.curatedTitle);
  const extractionTitle = readString(extraction.title);
  const title = curationTitleSlot.text ?? (curationTitleSlot.removed ? null : (extractionTitle ?? (item.name?.trim() ? item.name : null)));
  const curationDescriptionSlot = projectedCuratedString(curation.curatedDescription);
  const extractionDescription = readString(extraction.description);
  const description = curationDescriptionSlot.text ?? (curationDescriptionSlot.removed ? null : extractionDescription);

  const variantFacts: Record<string, string> = {};
  const variantAttrs = extraction.variantAttributes;
  if (variantAttrs && typeof variantAttrs === 'object') {
    for (const [axis, value] of Object.entries(variantAttrs as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) variantFacts[String(axis).trim()] = value.trim();
    }
  }
  const curatedWeight = readString(curation.curatedWeight);
  const extractionWeight = readString(extraction.weight);
  const weight = curatedWeight ?? extractionWeight;
  if (weight) variantFacts.weight = weight;

  let requiredFields: string[];
  try {
    requiredFields = blockingPreparationFields();
  } catch {
    requiredFields = ['title'];
  }

  // NOTE (issue #367 gap 5): the stored record hash stays text+bundle-only
  // (stamp sites in onboarding-routes/product-curator are owned by the #366
  // worker); source-authority invalidation rides the verify revision token
  // plus explicit PUT invalidation instead of this hash.
  const listingHash = hashFinalListing({ title, description, variantFacts, requiredFields });
  const runId = typeof curation.classificationRunId === 'string' ? curation.classificationRunId : null;
  let evidenceHash = '';
  if (runId) {
    try {
      const evidence = getEvidenceByRun(runId);
      evidenceHash = hashEvidenceBundle(eligibleEvidenceFor(evidence, item.upc));
    } catch {
      evidenceHash = '';
    }
  }

   // Live policy digest when the caller supplies workspace context (release
   // paths); '' otherwise (advisory/review path — digest leg inert,
   // listing/evidence staleness still enforced).
   const modelPolicyDigest = currentPolicyDigestFor(policyContext?.workspacePath, policyContext?.workspaceId);

   return { listingHash, evidenceHash, modelPolicyDigest, sourceAuthority };
}

/**
 * Shared draft-variant projection (issue #366 gap 4): the facts actually
 * included in the released artifact — every extraction `variantAttributes`
 * entry plus the draft's own weight (curated-weight writes land in the
 * draft's weight; the change-set gate has no live curation text to read).
 * Change-set approval, package export, and direct push MUST all use this
 * helper so the frozen artifact hashes identically at every gate.
 */
export function draftVariantFactsFor(itemId: string, draftWeight: string | null): Record<string, string> {
  const facts: Record<string, string> = {};
  try {
    const item = findItemById(itemId);
    const extraction = asRecord(
      typeof item?.extractionData === 'string'
        ? item.extractionData
        : JSON.stringify(item?.extractionData ?? {}),
    ) ?? {};
    const attrs = extraction.variantAttributes;
    if (attrs && typeof attrs === 'object' && !Array.isArray(attrs)) {
      for (const [axis, value] of Object.entries(attrs as Record<string, unknown>)) {
        if (typeof value === 'string' && value.trim()) facts[String(axis).trim()] = value.trim();
      }
    }
  } catch {
    // Live state unreadable: weight-only projection still fails closed via
    // hash mismatch at the gate.
  }
  const weight = typeof draftWeight === 'string' && draftWeight.trim() ? draftWeight.trim() : null;
  if (weight) facts.weight = weight;
  return facts;
}

/**
 * Hashes for a frozen change-set draft artifact (issue #366 item 3): the
 * change-set gate compares the record against the draft being released —
 * draft title/description over the LIVE eligible bundle and live required
 * fields — never against live curated text a stale draft has superseded.
 */
export function draftListingEvidenceHashes(itemId: string, draft: DraftListingProjection, policyContext?: { workspacePath?: string; workspaceId?: string }): DraftListingHashes {
  const item = findItemById(itemId);
  const empty: DraftListingHashes = { listingHash: '', evidenceHash: '', modelPolicyDigest: '', requiredFields: [] };
  if (!item) return empty;
  const curation = asRecord(findCurationDataJsonById(itemId) ?? null) ?? {};
  let requiredFields: string[];
  try {
    requiredFields = blockingPreparationFields();
  } catch {
    requiredFields = ['title'];
  }
  const listingHash = hashFinalListing({
    title: draft.title,
    description: draft.description,
    variantFacts: draft.variantFacts,
    requiredFields,
  });
  const runId = typeof curation.classificationRunId === 'string' ? curation.classificationRunId : null;
  let evidenceHash = '';
  if (runId) {
    try {
      evidenceHash = hashEvidenceBundle(eligibleEvidenceFor(getEvidenceByRun(runId), item.upc));
    } catch {
      evidenceHash = '';
    }
  }
  // Live policy digest when the caller supplies workspace context;
  // '' otherwise (digest leg inert — the empty string never equals a real
  // stamped digest, so policy drift can only ever refuse, never bypass).
  // Callers on release paths MUST pass context (enforced at the call sites).
  const modelPolicyDigest = currentPolicyDigestFor(policyContext?.workspacePath, policyContext?.workspaceId);
  return { listingHash, evidenceHash, modelPolicyDigest, requiredFields };
}

/**
 * Deterministic remaining-coverage re-check (issue #366 item 4): after
 * optional-text removal, every remaining material claim must resolve
 * deterministically (supported, or contradicted-by-absence for a required
 * field that just became missing). Any claim needing the bounded model
 * Choice returns false — removal never recovers through an unresolved call.
 */
export function remainingCoverageDeterministic(listing: FinalListingInput, eligible: EligibleEvidence[]): boolean {
  const built = buildClaimUnits(listing);
  const { claims, overflow, oversized } = built;
  // Oversized units need semantic judgment over content that never fit the
  // bounded question — removal never recovers through them.
  if (oversized || overflow || claims.length === 0) return !overflow && !oversized;
  return claims.every((claim) => {
    if (!claim.material) return true;
    const verdict = deterministicClaimCheck(claim, eligible);
    return verdict.verdict === 'supported' || verdict.verdict === 'contradicted';
  });
}
