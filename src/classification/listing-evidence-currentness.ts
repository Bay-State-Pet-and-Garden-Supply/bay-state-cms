
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
import { findWorkspace, findWorkspacePathById } from '../db/repositories/workspace-repo';
import { getCurrentItemEvidenceView, acceptedEvidenceToClassificationEvidence } from '../onboarding/item-evidence';
import { findGateRunById } from '../db/repositories/classification-run-repo';
import { findListingStandard } from '../onboarding/listing-standards';
import { selectRunListingClassificationTarget } from './classification-readiness';
import { buildClaimUnits, deterministicClaimCheck, eligibleEvidenceFor, hashAcceptedEvidenceBundle, hashFinalListing, type EligibleEvidence, type FinalListingInput } from './listing-evidence';
import { captureModelPolicySnapshot } from '../onboarding/model-policy-snapshot';
import type { Product } from '../shared/schemas/product';

export interface ListingEvidenceCurrentHashes {
  listingHash: string;
  evidenceHash: string;
  modelPolicyDigest: string;
  /** Current accepted snapshot authority hash; empty when stale or unavailable. */
  sourceAuthority: string;
  /** Required fields from the exact active standard selected for the current run. */
  requiredFields: string[];
}
export type DraftAssetProvenance = NonNullable<Product['metadata']['imageProvenance']>[number];

/** Exact final-listing projection being checked (live or frozen draft). */
export interface DraftListingProjection {
  title: string | null;
  description: string | null;
  variantFacts: Record<string, string>;
  fields?: Record<string, unknown>;
  requiredFields?: string[];
  classificationRunId?: string;
  /** The validated final ShopSite product, including canonical media provenance. */
  product?: Pick<Product, 'core' | 'customFields' | 'metadata'>;
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

/** Accepted authority changes with live source state; raw source URLs are not authority. */
export function currentSourceAuthority(itemId: string, workspaceId?: string): string {
  try {
    const workspace = workspaceId ? null : findWorkspace();
    const resolvedWorkspaceId = workspaceId ?? workspace?.id;
    if (!resolvedWorkspaceId) return '';
    const current = getCurrentItemEvidenceView(resolvedWorkspaceId, itemId);
    return current.status === 'accepted' && current.evidence ? current.evidence.authorityHash : '';
  } catch {
    return '';
  }
}

const VARIANT_FIELD_NAMES = new Map([
  ['color', 'color'], ['size', 'size'], ['weight', 'weight'], ['dimensions', 'dimensions'],
  ['count', 'count'], ['packcount', 'packCount'], ['casepack', 'casePack'],
  ['flavor', 'flavor'], ['formula', 'formula'], ['material', 'material'],
  ['productform', 'productForm'], ['species', 'species'], ['unitofmeasure', 'unitOfMeasure'],
]);

function acceptedVariantFacts(evidence: NonNullable<ReturnType<typeof getCurrentItemEvidenceView>['evidence']>): Record<string, string> | null {
  const values = new Map<string, Set<string>>();
  for (const fact of evidence.facts) {
    const key = fact.field.trim().toLowerCase().replace(/[\s_-]+/gu, '');
    if (!VARIANT_FIELD_NAMES.has(key)) continue;
    const entries = values.get(key) ?? new Set<string>();
    entries.add(fact.value.trim());
    values.set(key, entries);
  }
  const result: Record<string, string> = {};
  for (const [key, entries] of values) {
    if (entries.size !== 1) return null;
    result[VARIANT_FIELD_NAMES.get(key)!] = [...entries][0]!;
  }
  return result;
}

function resolveRequiredFields(
  workspacePath: string,
  workspaceId: string,
  itemId: string,
  runId: string,
  projection?: DraftListingProjection,
): string[] | null {
  const item = findItemById(itemId);
  const run = findGateRunById(runId);
  if (!item || !run || run.workspaceId !== workspaceId || run.productSku !== item.upc ||
      (run.onboardingItemId !== null && run.onboardingItemId !== itemId)) return null;
  const target = selectRunListingClassificationTarget({ workspaceId, runId });
  if (target.source === 'none' || !target.categoryId || !target.productTypeId) return null;
  const standard = findListingStandard(workspacePath, target.categoryId, target.productTypeId);
  if (!standard) return null;
  const fields = [...new Set(standard.requirements.filter(requirement => requirement.required).map(requirement => requirement.field))].sort();
  if (projection?.requiredFields !== undefined) {
    const supplied = [...new Set(projection.requiredFields)].sort();
    if (supplied.join('\\0') !== fields.join('\\0')) return null;
  }
  return fields;
}

export function currentListingEvidenceHashes(
  itemId: string,
  parsedCuration?: Record<string, unknown> | null,
  policyContext?: { workspacePath?: string; workspaceId?: string },
  projection?: DraftListingProjection,
  runIdOverride?: string,
): ListingEvidenceCurrentHashes {
  const empty: ListingEvidenceCurrentHashes = { listingHash: '', evidenceHash: '', modelPolicyDigest: '', sourceAuthority: '', requiredFields: [] };
  const item = findItemById(itemId);
  if (!item) return empty;
  const workspace = policyContext?.workspaceId ? null : findWorkspace();
  const workspaceId = policyContext?.workspaceId ?? workspace?.id;
  const workspacePath = policyContext?.workspacePath ?? (workspaceId ? findWorkspacePathById(workspaceId) : null);
  if (!workspaceId || !workspacePath) return empty;
  const curation = parsedCuration ?? asRecord(findCurationDataJsonById(itemId) ?? null) ?? {};
  const runId = runIdOverride ?? projection?.classificationRunId ??
    (typeof curation.classificationRunId === 'string' ? curation.classificationRunId : null);
  if (!runId) return empty;
  let requiredFields: string[] | null;
  try { requiredFields = resolveRequiredFields(workspacePath, workspaceId, itemId, runId, projection); }
  catch { return empty; }
  if (!requiredFields) return empty;
  let accepted;
  try { accepted = getCurrentItemEvidenceView(workspaceId, itemId); }
  catch { return empty; }
  if (accepted.status !== 'accepted' || !accepted.evidence || accepted.evidence.sku !== item.upc) return empty;

  const extraction = asRecord(
    typeof item.extractionData === 'string' ? item.extractionData : JSON.stringify(item.extractionData ?? {}),
  ) ?? {};
  const curationTitle = projectedCuratedString(curation.curatedTitle);
  const curationDescription = projectedCuratedString(curation.curatedDescription);
  const title = projection
    ? projection.title
    : curationTitle.text ?? (curationTitle.removed ? null : (readString(extraction.title) ?? (item.name?.trim() ? item.name : null)));
  const description = projection
    ? projection.description
    : curationDescription.text ?? (curationDescription.removed ? null : readString(extraction.description));
  const variantFacts = projection ? projection.variantFacts : acceptedVariantFacts(accepted.evidence);
  if (!variantFacts) return empty;
  if (!projection) {
    const curatedWeight = readString(curation.curatedWeight);
    if (curatedWeight) variantFacts.weight = curatedWeight;
  }
  const listingHash = hashFinalListing({ title, description, variantFacts, requiredFields });
  let evidenceHash: string;
  try {
    const eligible = eligibleEvidenceFor(acceptedEvidenceToClassificationEvidence(accepted.evidence, runId), item.upc);
    evidenceHash = hashAcceptedEvidenceBundle(accepted.evidence.evidenceHash, eligible);
  } catch { return empty; }
  return {
    listingHash,
    evidenceHash,
    modelPolicyDigest: currentPolicyDigestFor(policyContext?.workspacePath, workspaceId),
    sourceAuthority: accepted.evidence.authorityHash,
    requiredFields,
  };
}

/**
 * Draft variant facts come from the exact current accepted snapshot, never
 * from mutable extraction JSON. The frozen draft's own weight is retained.
 */
export function draftVariantFactsFor(itemId: string, draftWeight: string | null, workspaceId?: string): Record<string, string> {
  const facts: Record<string, string> = {};
  try {
    const workspace = workspaceId ? null : findWorkspace();
    const resolvedWorkspaceId = workspaceId ?? workspace?.id;
    if (resolvedWorkspaceId) {
      const current = getCurrentItemEvidenceView(resolvedWorkspaceId, itemId);
      if (current.status === 'accepted' && current.evidence) {
        Object.assign(facts, acceptedVariantFacts(current.evidence) ?? {});
      }
    }
  } catch {
    // Evidence hash below is empty when the accepted view is unavailable.
  }
  const weight = typeof draftWeight === 'string' && draftWeight.trim() ? draftWeight.trim() : null;
  if (weight) facts.weight = weight;
  return facts;
}

/** Hash the exact supplied draft against current accepted evidence and standard fields. */
export function draftListingEvidenceHashes(
  itemId: string,
  draft: DraftListingProjection,
  policyContext?: { workspacePath?: string; workspaceId?: string },
): DraftListingHashes {
  const hashes = currentListingEvidenceHashes(itemId, undefined, policyContext, draft);
  return {
    listingHash: hashes.listingHash,
    evidenceHash: hashes.evidenceHash,
    modelPolicyDigest: hashes.modelPolicyDigest,
    requiredFields: hashes.requiredFields,
  };
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
