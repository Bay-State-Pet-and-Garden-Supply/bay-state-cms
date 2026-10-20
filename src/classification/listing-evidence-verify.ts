/**
 * Listing-Evidence Operator Verification Service (issue #367).
 *
 * Authenticated manual resolution of an eligible unresolved listing claim.
 * Records an operator_verified verdict bound to exact claim/evidence hashes
 * — never a model-supported relabel, never approval-as-evidence.
 *
 * Server-owned: actor + workspace + eligibility derived from durable state;
 * no client-supplied authority or product mutation. Single transaction:
 * idempotent receipt (action token) + curation write + audit + receipt
 * completion. Stale/mismatched refusals make no writes and preserve input.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../db/connection';
import { findItemById, findCurationDataJsonById, updateItemCurationData } from '../db/repositories/onboarding-item-repo';
import { findBatchById } from '../db/repositories/onboarding-batch-repo';
import { claimReceipt, completeReceipt, failReceipt } from '../db/repositories/onboarding-operation-receipt-repo';
import { findProfileByDomain } from '../db/repositories/extractor-profile-repo';
import { getActiveManualEvidenceAttestationForItem, getManualEvidenceAttestation, hashManualEvidenceFieldValue, parseManualEvidenceImageRights } from '../db/repositories/onboarding-manual-evidence-repo';
import { getValidatedOnboardingRun } from '../db/repositories/classification-run-repo';
import { markReviewInvalidated } from '../db/repositories/onboarding-review-repo';
import { addAuditLog } from '../db/repositories/audit-log-repo';
import { hasUnresolvedHardConflicts } from '../db/repositories/onboarding-conflict-repo';
import { getVariantIdentityDisposition } from '../db/repositories/variant-identity-disposition-repo';
import {
  ListingEvidenceClaimSchema,
  ListingEvidenceValidationSchema,
  type ListingEvidenceClaim,
  type ListingEvidenceValidation,
} from '../shared/schemas/onboarding';
import { currentListingEvidenceHashes, currentSourceAuthority } from './listing-evidence-currentness';
import { evaluateListingEvidenceGate } from './listing-evidence-gate';
import { hasBlockingDriftForSku } from '../db/repositories/drift-repo';
import { validateNameDecisionForReview } from './review-completion-gate';
import type { Principal } from '../server/authenticated-principal';

/**
 * Maximum operator-verifiable claims per submission (bounded; the
 * 24-claim semantic bound still caps the record — verdicts over an
 * overflowed record stay `unavailable` and unresolvable here).
 */
export const LISTING_VERIFY_MAX_CLAIMS = 8;

export type ListingVerifyRejectCode =
  | 'item_not_found'
  | 'workspace_mismatch'
  | 'no_validation_record'
  | 'claim_not_found'
  | 'claim_not_unresolved'
  | 'revision_stale'
  | 'evidence_stale'
  | 'idempotency_conflict'
  | 'interrupted_command'
  | 'hard_gate_refusal'
  | 'invalid_observation'
  | 'invalid_provenance'
  | 'record_malformed'
  | 'record_overflow';

export interface ListingVerifyInput {
  workspaceId: string;
  itemId: string;
  /** Exact claim ids (from the persisted record) the operator resolves. */
  claimIds: string[];
  /** Fresh verbatim observation/attestation text (the actual current check). */
  observation: string;
  /** Why the observation was made + what was physically inspected. */
  provenance: string;
  /** Exact current evidence-bundle hash the operator saw. */
  expectedEvidenceHash: string;
  /** Expected curation revision (opaque token issued by the detail writer). */
  expectedRevision: string;
  /** Idempotency / action token (required). */
  actionToken: string;
}

export type ListingVerifyResult =
  | {
      ok: true;
      replay: boolean;
      receiptId: string;
      record: ListingEvidenceValidation;
      resolvedClaimIds: string[];
      aggregateStatus: ListingEvidenceValidation['status'];
    }
  | { ok: false; code: ListingVerifyRejectCode; reason: string; status: number };

interface OwnedItem {
  id: string;
  batchId: string;
  upc: string;
  stage: unknown;
  curationData: Record<string, unknown> | null;
}

function loadOwnedItem(itemId: string, workspaceId: string): { item: OwnedItem } | { rejection: Extract<ListingVerifyResult, { ok: false }> } {
  const item = findItemById(itemId);
  if (!item) {
    return { rejection: { ok: false, code: 'item_not_found', reason: 'Item not found', status: 404 } };
  }
  const batch = findBatchById(item.batchId);
  if (!batch || batch.workspaceId !== workspaceId) {
    return { rejection: { ok: false, code: 'workspace_mismatch', reason: 'Onboarding item not found', status: 404 } };
  }
  let curation: Record<string, unknown> | null = null;
  try {
    const raw = findCurationDataJsonById(itemId);
    if (raw) {
      const parsed: unknown = JSON.parse(String(raw));
      if (parsed && typeof parsed === 'object') curation = parsed as Record<string, unknown>;
    }
  } catch {
    curation = null;
  }
  return {
    item: {
      id: item.id,
      batchId: item.batchId,
      upc: item.upc,
      stage: item.stage,
      curationData: curation,
    },
  };
}

/** Canonical request hash over the exact verification payload (token replay binding). */
export function computeListingVerifyHash(input: {
  workspaceId: string;
  batchId: string;
  itemId: string;
  claimIds: string[];
  claimHashes: string[];
  evidenceHash: string;
  listingHash: string;
  expectedRevision: string;
  observationHash: string;
  provenanceHash: string;
  principal: string;
}): string {
  // Id→hash pairs sort together so the binding can never pair a claim id
  // with another claim's hash under reordering.
  const pairs = input.claimIds
    .map((id, index) => `${id}:${input.claimHashes[index] ?? ''}`)
    .sort();
  const canonical = JSON.stringify({
    domain: 'listing-evidence-verify-v1',
    workspaceId: input.workspaceId,
    batchId: input.batchId,
    itemId: input.itemId,
    claimPairs: pairs,
    evidenceHash: input.evidenceHash,
    listingHash: input.listingHash,
    expectedRevision: input.expectedRevision,
    observationHash: input.observationHash,
    provenanceHash: input.provenanceHash,
    principal: input.principal,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
/**
 * Canonical brand-identity match (issue #367 gap 3): punctuation-aware
 * brand identity matching, never substring/all-token heuristics. Both sides
 * canonicalize (lowercase, non-alphanumerics → space, collapse) and match
 * ONLY when a canonical brand NAME (the full hint, or a multi-token
 * leading/trailing segment of it) appears as a whole-token span of the
 * claim, or the whole canonical claim is a whole-token span of the hint.
 * Neither direction launders: "Made by Acana" with hint "Acana Pet Foods"
 * passes (single-token fragment, not the brand name); "Purina Pro Plan"
 * vs "Purina Pro-Plan" matches (same canonical name); "delicate" with hint
 * "Cat" passes (no whole-token identity span).
 */
function canonicalBrandTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token.length > 0);
}
function tokenSpanIncludes(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    let match = true;
    for (let i = 0; i < needle.length; i++) {
      if (haystack[start + i] !== needle[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}
function claimAssertsBrandIdentity(claimText: string, brandHint: string): boolean {
  const claimTokens = canonicalBrandTokens(claimText);
  const hintTokens = canonicalBrandTokens(brandHint);
  if (claimTokens.length === 0 || hintTokens.length === 0) return false;
  // Whole canonical name either direction, as a whole-token span.
  if (tokenSpanIncludes(claimTokens, hintTokens)) return true;
  if (tokenSpanIncludes(hintTokens, claimTokens)) return true;
  // Multi-token leading/trailing segments of a multi-word hint (e.g. hint
  // "Acana Pet Foods", claim "Made by Acana Pet" — a genuine brand-name
  // span, not a one-word fragment like "Acana" alone).
  if (hintTokens.length >= 2) {
    for (let len = hintTokens.length - 1; len >= 2; len--) {
      const leading = hintTokens.slice(0, len);
      const trailing = hintTokens.slice(hintTokens.length - len);
      if (tokenSpanIncludes(claimTokens, leading)) return true;
      if (tokenSpanIncludes(claimTokens, trailing)) return true;
    }
  }
  return false;
}

/**
 * Affirmative claim-specific attestation (issue #367 gaps 1–2): every
 * resolved claim needs its OWN current, affirmative attestation in the
 * observation: an exact, punctuation-aware whole-token span of ≥3
 * significant words of the claim (or the full claim text for short claims)
 * PLUS an affirmative verification verb ("verif…", "confirm…", "match…",
 * "attest…", "witness…", "observ…") in the same observation — outside any
 * negated clause ("cannot confirm", "did not verify", "unable to match",
 * "no confirmation", "not verified", "fails to match" refuse). Quoting
 * alone never establishes support ("I did not inspect …" quotes but does
 * not support); one linked claim never certifies siblings. Generic praise
 * ("looks good!!!!") names nothing and refuses. Numbers and units are
 * significant tokens (never dropped): "weight: 5 lb" requires "5" and "lb"
 * in the quoted span, so an observation about another weight cannot match.
 * When a live manual-evidence attestation roots provenance for this item,
 * the value-bound leg below still applies per claim — the escape hatch is
 * gone; only the attestation checklist/value check can satisfy it.
 */
const ATTESTATION_VERBS = ['verif', 'confirm', 'match', 'attest', 'witness', 'observ'];
/** Negation heads that void an attestation verb ("cannot verify", "no match", "not confirmed", …). */
const ATTESTATION_NEGATIONS = ['not', 'no', 'never', 'cannot', "can't", "couldn't", 'couldnt', 'unable', 'without', 'didnt', "didn't", 'dont', "don't", 'doesnt', "doesn't", 'failed', 'fails', 'fail'];
function clauseNegatesVerb(clause: string, verbIndex: number): boolean {
  const before = clause.slice(Math.max(0, verbIndex - 40), verbIndex).toLowerCase();
  return ATTESTATION_NEGATIONS.some((neg) => new RegExp(`(?:^|[^a-z])${neg}(?:[^a-z]|$)`).test(before));
}
function hasAffirmativeVerb(observation: string): boolean {
  const lowered = observation.toLowerCase();
  for (const clause of lowered.split(/[.!?;]+/)) {
    for (const verb of ATTESTATION_VERBS) {
      let from = 0;
      for (;;) {
        const at = clause.indexOf(verb, from);
        if (at < 0) break;
        if (!clauseNegatesVerb(clause, at)) return true;
        from = at + verb.length;
      }
    }
  }
  return false;
}
function significantClaimTokens(claimText: string): string[] {
  // Numbers and units are significant (never dropped): a 2-char unit ("5 lb",
  // "2 oz") or any numeric token must appear in the quoted span, so an
  // observation about another weight ("weight: 5 kg" vs "weight: 5 lb")
  // cannot match. Single letters ("a", "x") stay insignificant.
  return canonicalBrandTokens(claimText).filter((token) => token.length >= 2 || /[0-9]/.test(token));
}
function observationSupportsClaim(observation: string, claimText: string): boolean {
  const obsTokens = canonicalBrandTokens(observation);
  const claimTokens = significantClaimTokens(claimText);
  if (obsTokens.length === 0 || claimTokens.length === 0) return false;
  const obsJoined = ` ${obsTokens.join(' ')} `;
  let quoted: boolean;
  if (claimTokens.length < 3) {
    quoted = obsJoined.includes(` ${claimTokens.join(' ')} `);
  } else {
    quoted = false;
    for (let i = 0; i + 2 < claimTokens.length; i++) {
      if (obsJoined.includes(` ${claimTokens[i]} ${claimTokens[i + 1]} ${claimTokens[i + 2]} `)) {
        quoted = true;
        break;
      }
    }
  }
  if (!quoted) return false;
  return hasAffirmativeVerb(observation);
}

/**
 * Value binding for one target claim against the active manual-evidence
 * attestation (issue #367 gap 2): the claim's carrying field must be in
 * the attestation checklist AND the checklist value hash must equal the
 * canonical hash of the claim's CURRENT live FINAL value — the same final
 * projection the claim was built from (curated → extraction → register),
 * including the exact structured variant value. An attestation over an old
 * extraction title cannot authorize a new curated description: the
 * checklist entry must hash-match the current final value, not the
 * extraction text alone. Variant claims bind `axis: value` against the
 * extraction variantAttributes axis; title/description bind the final
 * projected text. False when no checklist entry covers the claim.
 */
function attestationCoversClaim(attestationId: string, itemId: string, claim: ListingEvidenceClaim): boolean {
  const item = findItemById(itemId);
  if (!item) return false;
  let extraction: Record<string, unknown>;
  try {
    const raw = item.extractionData;
    if (typeof raw === 'string') {
      const parsed: unknown = JSON.parse(raw);
      extraction = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } else if (raw && typeof raw === 'object') {
      extraction = raw as unknown as Record<string, unknown>;
    } else {
      extraction = {};
    }
  } catch {
    return false;
  }
  let curation: Record<string, unknown> = {};
  try {
    const rawCuration = findCurationDataJsonById(itemId);
    if (rawCuration) {
      const parsed: unknown = JSON.parse(String(rawCuration));
      if (parsed && typeof parsed === 'object') curation = parsed as Record<string, unknown>;
    }
  } catch {
    return false;
  }
  const pickFinal = (curated: unknown, extracted: unknown, fallback: unknown): string | null => {
    if (typeof curated === 'string' && curated.trim()) return curated.trim();
    if (typeof extracted === 'string' && extracted.trim()) return extracted.trim();
    if (typeof fallback === 'string' && fallback.trim()) return fallback.trim();
    return null;
  };
  let field: string;
  let liveValue: unknown;
  if (claim.field === 'variant') {
    const axis = claim.text.split(':')[0]?.trim();
    if (!axis) return false;
    // The checklist is keyed by manual-evidence field name: only the `weight`
    // axis exists there (other variant axes are never attestable here).
    // A non-weight variant claim therefore binds by exact `axis: value` text:
    // the attestation covers it only when its weight value equals that text;
    // otherwise false (never authorized through an unrelated field).
    const axisAttrs = extraction.variantAttributes;
    const axisValue = axisAttrs && typeof axisAttrs === 'object' && !Array.isArray(axisAttrs) && axis in axisAttrs
      ? (axisAttrs as Record<string, unknown>)[axis]
      : undefined;
    if (axis.toLowerCase() === 'weight') {
      field = 'weight';
      liveValue = pickFinal(curation.curatedWeight, extraction.weight, null);
    } else {
      field = axis;
      liveValue = typeof axisValue === 'string' ? axisValue : null;
    }
  } else if (claim.field === 'title') {
    field = 'title';
    liveValue = pickFinal(curation.curatedTitle, extraction.title, item.name);
  } else {
    field = 'description';
    liveValue = pickFinal(curation.curatedDescription, extraction.description, null);
  }
  if (typeof liveValue !== 'string' || !liveValue.trim()) return false;
  // Per-field compare against the attestation checklist (issue #367 gap 2):
  // the checklist entry for this exact field must hash-match the CURRENT
  // final value. verifyManualEvidenceAttestationHash requires exact
  // whole-payload field-set equality, so it can never satisfy a single-claim
  // check — compare this field's entry directly instead.
  try {
    const row = getManualEvidenceAttestation(attestationId);
    if (!row || row.superseded_at !== null) return false;
    const checklist = JSON.parse(row.field_checklist_json) as Record<string, { valueHash?: unknown }>;
    const entry = checklist[field];
    if (!entry || typeof entry.valueHash !== 'string') return false;
    return entry.valueHash === hashManualEvidenceFieldValue(liveValue.trim());
  } catch {
    return false;
  }
}

function shaHex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Opaque expected-revision token: hash of the canonical current curation
 * JSON PLUS the live source authority (issue #367 gap 5). The route helper
 * currentVerifyRevisionForItem stamps the same composite, so a `PUT
 * /items/:id` change to `source_url` — which leaves curation JSON
 * untouched — still rotates the token and refuses a stale submission with
 * revision_stale. Optional authority param preserves the single-arg hash
 * for callers/tests that hash curation alone.
 */
export function currentCurationRevision(curation: Record<string, unknown> | null, sourceAuthority?: string): string {
  if (sourceAuthority === undefined) return shaHex(JSON.stringify(curation ?? null));
  return shaHex(JSON.stringify({ curation: curation ?? null, sourceAuthority }));
}

/**
 * Hard-gate sweep: verification can never bypass identity/variant/domain,
 * image rights, unresolved hard source conflicts, reviewed classification,
 * drift, or field ownership. Each refusal names the responsible correction
 * flow; none is waivable here.
 *
 * Runs against LIVE item state inside the caller's transaction where
 * possible (pure reads — safe inside or outside).
 */
function hardGateRefusal(itemId: string, upc: string, workspaceId: string, targetClaimIds: string[] = []): { code: 'hard_gate_refusal'; reason: string } | null {
  const item = findItemById(itemId);
  if (!item) return { code: 'hard_gate_refusal', reason: 'Item not found; re-open it from the batch workspace.' };

  // 1. Identity: register/expected-name presence (imported identity tuple).
  const itemRec: Record<string, unknown> = item as unknown as Record<string, unknown>;
  const rawIdentity = typeof itemRec.rawIdentityJson === 'string' ? itemRec.rawIdentityJson : null;
  const normIdentity = typeof itemRec.normalizedIdentityJson === 'string' ? itemRec.normalizedIdentityJson : null;
  if (typeof rawIdentity === 'string' && typeof normIdentity === 'string' && rawIdentity.trim() && normIdentity.trim()) {
    try {
      const raw = JSON.parse(rawIdentity) as { upc?: unknown };
      const norm = JSON.parse(normIdentity) as { gtin?: unknown; upc?: unknown };
      const rawUpc = typeof raw?.upc === 'string' ? raw.upc.trim() : '';
      const normId = typeof norm?.gtin === 'string' ? norm.gtin.trim() : typeof norm?.upc === 'string' ? norm.upc.trim() : '';
      if (!rawUpc || !normId || rawUpc !== normId) {
        return {
          code: 'hard_gate_refusal',
          reason:
            'identity_unresolved: the imported identity tuple is inconsistent (raw vs normalized UPC); resolve identity in the import/identity flow before verifying listing claims.',
        };
      }
    } catch {
      return {
        code: 'hard_gate_refusal',
        reason: 'identity_unresolved: the imported identity tuple is corrupt; resolve identity in the import/identity flow before verifying listing claims.',
      };
    }
  }

  // 2. Variant identity: an explicit unresolved-variant disposition routes
  // to variant selection — verification cannot overrule it.
  try {
    const disposition = getVariantIdentityDisposition(itemId);
    if (disposition) {
      return {
        code: 'hard_gate_refusal',
        reason: `variant_identity_unresolved: ${disposition.reason} — resolve the variant identity in variant selection before verifying listing claims.`,
      };
    }
  } catch {
    // Disposition table unreadable — fail closed on the check itself.
    return {
      code: 'hard_gate_refusal',
      reason: 'variant disposition unreadable; resolve the variant identity in variant selection before verifying listing claims.',
    };
  }

  // 3. Domain: official-page items need a usable extractor profile for the
  // source domain; distributor items skip (Amendment B, profile-free).
  if (item.sourceType !== 'distributor_record') {
    try {
      const url = typeof item.sourceUrl === 'string' ? item.sourceUrl.trim() : '';
      let domain: string | null = null;
      if (url) {
        try {
          domain = new URL(url).hostname.trim().toLowerCase().replace(/^www\./, '') || null;
        } catch {
          domain = null;
        }
      }
      if (domain) {
        if (!findProfileByDomain(domain)) {
          return {
            code: 'hard_gate_refusal',
            reason: `domain_profile_missing: no usable extractor profile for ${domain}; build the domain profile in Settings → Profiles before verifying listing claims.`,
          };
        }
      }
    } catch {
      return {
        code: 'hard_gate_refusal',
        reason: 'domain profile unreadable; build the domain profile in Settings → Profiles before verifying listing claims.',
      };
    }
  }

  // 4. Image rights (issue #367 gap 4): per-image rights, source-aware.
  // Reviewer-selected media (primaryImage + orderedAdditional) needs an
  // approval for the EXACT manual URL: every selected URL must appear in
  // the active attestation's image_rights_json — a bare attestation
  // existence never satisfies this leg. Official-page images selected
  // through /items/:id/media are NOT manual evidence and need NO manual
  // attestation: when no active attestation exists, URLs that the manual
  // flow never submitted pass (official-page sourcing); only URLs the
  // operator submitted as manual images without rights refuse.
  try {
    const curationJson = findCurationDataJsonById(itemId);
    if (curationJson) {
      const parsed: unknown = JSON.parse(String(curationJson));
      const curation = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
      const reviewedMedia = curation?.reviewedMedia as
        | { primaryImage?: unknown; orderedAdditional?: unknown; suppressed?: unknown }
        | undefined;
      const mediaUrls: string[] = [];
      if (typeof reviewedMedia?.primaryImage === 'string' && reviewedMedia.primaryImage.trim()) {
        mediaUrls.push(reviewedMedia.primaryImage.trim());
      }
      if (Array.isArray(reviewedMedia?.orderedAdditional)) {
        for (const u of reviewedMedia.orderedAdditional) {
          if (typeof u === 'string' && u.trim()) mediaUrls.push(u.trim());
        }
      }
      if (mediaUrls.length > 0) {
        const attestation = getActiveManualEvidenceAttestationForItem(itemId);
        if (attestation) {
          let approved: string[];
          try {
            approved = parseManualEvidenceImageRights(attestation).map((entry) => entry.imageUrl);
          } catch {
            return {
              code: 'hard_gate_refusal',
              reason: 'manual_image_rights_corrupt: the manual-evidence image-rights approvals are corrupt; re-attest image rights in the manual-evidence flow before verifying listing claims.',
            };
          }
          const approvedSet = new Set(approved);
          const missing = mediaUrls.filter((url) => !approvedSet.has(url));
          if (missing.length > 0) {
            return {
              code: 'hard_gate_refusal',
              reason: `manual_image_rights_missing: reviewer-selected media ${missing.slice(0, 3).join(', ')} carries no per-image rights approval for the exact manual URL; attest image rights in the manual-evidence flow before verifying listing claims.`,
            };
          }
        }
      }
    }
  } catch {
    return {
      code: 'hard_gate_refusal',
      reason: 'image rights state unreadable; attest image rights in the manual-evidence flow before verifying listing claims.',
    };
  }

  // 5. Hard source conflicts: unresolved hard conflicts route to conflict
  // resolution — verification cannot overrule them.
  try {
    if (hasUnresolvedHardConflicts(itemId)) {
      return {
        code: 'hard_gate_refusal',
        reason: 'hard_conflict_open: an unresolved hard source conflict exists for this item; resolve it in conflict resolution before verifying listing claims.',
      };
    }
  } catch {
    return {
      code: 'hard_gate_refusal',
      reason: 'conflict state unreadable; resolve conflicts in conflict resolution before verifying listing claims.',
    };
  }

  // 6. Reviewed classification: the reviewed-classification backstops
  // (name decision + canonical pair/profile readiness, plus their
  // run-ownership roots) must already pass. Grandfathering (explicitly
  // accepted, documented here and in the route): when the curation
  // carries no classificationRunId (runless/legacy items predating
  // classification runs), this leg is vacuous — there is no run to own
  // and no name gate enrolled, so there is nothing to re-check. Such
  // items never passed through the classification backstop, and
  // verification must not invent a run-ownership requirement for them.
  // Items that DO carry a run id are fully gated below (run ownership +
  // completion + name gate). The undecided-proposal and
  // page-assignment legs of the full review gate are NOT re-imposed here:
  // they are Review-completion concerns, and the #366 gate keeps enforcing
  // them (plus this gate's own currentness check) at every release path —
  // verification of a needs_review claim does not skip them.
  try {

    const curationJson = findCurationDataJsonById(itemId);
    let runId: string | null = null;
    if (curationJson) {
      try {
        const parsed: unknown = JSON.parse(String(curationJson));
        const c = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
        runId = typeof c?.classificationRunId === 'string' ? (c.classificationRunId as string) : null;
      } catch {
        runId = null;
      }
    }
    if (runId) {
      const owned = getValidatedOnboardingRun(runId, workspaceId, itemId, upc);
      if (!owned) {
        return {
          code: 'hard_gate_refusal',
          reason: 'run_not_found: the classification run is not owned by this workspace/item/SKU; resolve it in its owning flow before verifying listing claims.',
        };
      }
      if (owned.status !== 'completed' && owned.status !== 'completed_with_abstentions') {
        return {
          code: 'hard_gate_refusal',
          reason: `run_not_completed: classification run status is "${owned.status}"; resolve it in its owning flow before verifying listing claims.`,
        };
      }
      const nameGate = validateNameDecisionForReview(itemId);
      if (nameGate && nameGate.ok === false) {
        return {
          code: 'hard_gate_refusal',
          reason: `${nameGate.code}: ${nameGate.reason} — resolve it in its owning flow (classification/semantic/pages/name) before verifying listing claims.`,
        };
      }
    }
  } catch {
    return {
      code: 'hard_gate_refusal',
      reason: 'classification state unreadable; resolve it in its owning flow before verifying listing claims.',
    };
  }

  // 7. Drift: open/reconciling remote drift routes to drift reconciliation.
  try {
    if (hasBlockingDriftForSku(workspaceId, upc)) {
      return {
        code: 'hard_gate_refusal',
        reason: 'remote_drift_open: open or reconciling remote drift exists for this SKU; reconcile drift before verifying listing claims.',
      };
    }
  } catch {
    return {
      code: 'hard_gate_refusal',
      reason: 'drift state unreadable; reconcile drift before verifying listing claims.',
    };
  }

  // 8. Field ownership: a target claim whose normalized text IS the item's
  // brand identity can never be operator-verified here — Brand is a
  // classifier-protected target (never a classifier-owned output), so such
  // a claim routes to the Brand flow. Verification writes claim verdicts,
  // never protected catalog fields; a whole-Brand assertion masquerading as
  // a listing claim must not be laundered into an operator_verified verdict.
  // The comparison reads the LIVE item row and curation inside the caller's
  // transaction (pure reads — safe inside or outside) and matches only the
  // submitted target claim texts against the normalized item brandHint.
  try {
    const liveItem = findItemById(itemId);
    const rawHint = (liveItem as unknown as { brandHint?: unknown } | undefined)?.brandHint;
    const hint = typeof rawHint === 'string' ? rawHint.trim().toLowerCase().replace(/\s+/g, ' ') : '';
    if (hint && targetClaimIds.length > 0) {
      const liveCurationJson = findCurationDataJsonById(itemId);
      if (liveCurationJson) {
        const parsedCuration: unknown = JSON.parse(String(liveCurationJson));
        const curation = parsedCuration && typeof parsedCuration === 'object' ? (parsedCuration as Record<string, unknown>) : null;
        const recordParsed = ListingEvidenceValidationSchema.safeParse(curation?.listingEvidenceValidation);
        if (recordParsed.success) {
          const liveById: Record<string, string> = {};
          for (const claim of recordParsed.data.claims) liveById[claim.id] = claim.text;
          for (const id of targetClaimIds) {
            const text = liveById[id];
            if (typeof text === 'string' && claimAssertsBrandIdentity(text, hint)) {
              return {
                code: 'hard_gate_refusal',
                reason: `brand_ownership: claim ${id} asserts the item brand identity ("${text.slice(0, 80)}"); Brand is classifier-protected — resolve it in the Brand flow before verifying listing claims.`,
              };
            }
          }
        }
      }
    }
  } catch {
    return {
      code: 'hard_gate_refusal',
      reason: 'brand ownership state unreadable; resolve Brand ownership in the Brand flow before verifying listing claims.',
    };
  }
  return null;
}

/**
 * Authenticated operator verification of eligible unresolved claims.
 * Fail-closed: every refusal returns before any write; receipts fail on
 * recorded (non-replay) errors so a fixable 400/409 does not force a new
 * action token via a stranded `started` row.
 */
export function verifyListingEvidence(
  input: ListingVerifyInput,
  principal: Principal,
): ListingVerifyResult {
  const actionToken = (input.actionToken ?? '').trim();
  if (!actionToken) {
    return { ok: false, code: 'invalid_observation', reason: 'An action token is required.', status: 400 };
  }
  const observation = (input.observation ?? '').trim();
  if (!observation || observation.length < 12) {
    return {
      ok: false,
      code: 'invalid_observation',
      reason: 'A real current observation (at least 12 characters describing what was verified) is required.',
      status: 400,
    };
  }
  if (observation.length > 2000) {
    return { ok: false, code: 'invalid_observation', reason: 'The observation exceeds 2000 characters.', status: 400 };
  }
  const provenance = (input.provenance ?? '').trim();
  if (!provenance || provenance.length < 12) {
    return {
      ok: false,
      code: 'invalid_provenance',
      reason: 'Provenance (what was inspected and where) of at least 12 characters is required.',
      status: 400,
    };
  }
  if (provenance.length > 2000) {
    return { ok: false, code: 'invalid_provenance', reason: 'Provenance exceeds 2000 characters.', status: 400 };
  }
  const claimSeen: Record<string, true> = {};
  const claimIds: string[] = [];
  for (const raw of input.claimIds ?? []) {
    const trimmed = String(raw).trim();
    if (!trimmed || claimSeen[trimmed]) continue;
    claimSeen[trimmed] = true;
    claimIds.push(trimmed);
  }
  if (claimIds.length === 0 || claimIds.length > LISTING_VERIFY_MAX_CLAIMS) {
    return {
      ok: false,
      code: 'invalid_observation',
      reason: `Submit 1–${LISTING_VERIFY_MAX_CLAIMS} claim ids per verification.`,
      status: 400,
    };
  }
  if (!/^[a-f0-9]{64}$/.test(input.expectedEvidenceHash ?? '')) {
    return { ok: false, code: 'evidence_stale', reason: 'The expected evidence hash is malformed; reload the current claim state.', status: 409 };
  }

  const loaded = loadOwnedItem(input.itemId, input.workspaceId);
  if ('rejection' in loaded) return loaded.rejection;
  const owned = loaded.item;

  const rawRecord = owned.curationData?.listingEvidenceValidation ?? null;
  if (rawRecord === undefined || rawRecord === null) {
    return {
      ok: false,
      code: 'no_validation_record',
      reason: 'No listing-evidence record exists for this item; run the listing check before verifying.',
      status: 409,
    };
  }
  const parsedRecord = ListingEvidenceValidationSchema.safeParse(rawRecord);
  if (!parsedRecord.success) {
    return {
      ok: false,
      code: 'record_malformed',
      reason: 'The persisted listing-evidence record is malformed; re-run the listing check before verifying.',
      status: 409,
    };
  }
  const preRecord = parsedRecord.data;
  if (preRecord.overflow) {
    return {
      ok: false,
      code: 'record_overflow',
      reason: 'The listing exceeds the semantic claim bound; narrow it and re-run — overflow cannot be verified.',
      status: 409,
    };
  }
  const preById: Record<string, ListingEvidenceClaim> = {};
  for (const c of preRecord.claims) preById[c.id] = c;
  const preTargets: ListingEvidenceClaim[] = [];
  for (const id of claimIds) {
    const claim = preById[id];
    if (!claim) {
      return { ok: false, code: 'claim_not_found', reason: `Claim ${id} is not part of the current listing-evidence record.`, status: 404 };
    }
    preTargets.push(claim);
  }

  // Idempotent receipt inputs derive from the operator-supplied binding
  // (claim hashes + listing hash as seen at submit time). The authoritative
  // guards below re-run inside the transaction after the replay check, so a
  // same-payload replay never trips the revision guard.
  const requestHash = computeListingVerifyHash({
    workspaceId: input.workspaceId,
    batchId: owned.batchId,
    itemId: input.itemId,
    claimIds,
    claimHashes: preTargets.map((c) => c.claimHash),
    evidenceHash: input.expectedEvidenceHash,
    listingHash: preRecord.listingHash,
    expectedRevision: (input.expectedRevision ?? '').trim(),
    observationHash: shaHex(observation),
    provenanceHash: shaHex(provenance),
    principal: principal.actor,
  });
  if (!/^[a-f0-9]{64}$/.test(requestHash)) {
    return { ok: false, code: 'invalid_observation', reason: 'Verification hash failure; retry.', status: 400 };
  }

  const failInside = (
    receiptId: string,
    code: ListingVerifyRejectCode,
    reason: string,
    status: number,
  ): Extract<ListingVerifyResult, { ok: false }> => {
    try {
      failReceipt(receiptId, JSON.stringify({ code, message: reason }));
    } catch {
      /* best-effort */
    }
    return { ok: false, code, reason, status };
  };

  const db = getDb();
  const run = db.transaction(() => {
    const claim = claimReceipt({
      workspaceId: input.workspaceId,
      batchId: owned.batchId,
      operation: 'listing_evidence_verify',
      principal: principal.actor,
      role: principal.role,
      idempotencyKey: actionToken,
      requestHash,
    });
    if (claim.isConflict) {
      return { ok: false as const, code: 'idempotency_conflict', reason: 'Action token was used with a different verification payload.', status: 409 };
    }
    if (claim.isReplay && !claim.receipt.detailsJson) {
      return {
        ok: false as const,
        code: 'revision_stale' as const,
        reason: 'This action token already completed; the stored receipt carries no replayable record — reload and verify with a new token.',
        status: 409 as const,
      };
    }
    if (claim.isReplay && claim.receipt.detailsJson) {
      try {
        const prior = JSON.parse(claim.receipt.detailsJson) as {
          resolvedClaimIds?: string[];
          observationHash?: string;
          provenanceHash?: string;
          principal?: string;
          record?: ListingEvidenceValidation;
          aggregateStatus?: ListingEvidenceValidation['status'];
        };
        // Exact replay: claimReceipt returns isReplay only when the full
        // payload hash matches, so identity reduces to: same payload, and
        // the stored verified record is still live (no later edit).
        if (
          prior.record &&
          prior.observationHash === shaHex(observation) &&
          prior.provenanceHash === shaHex(provenance) &&
          prior.principal === principal.actor
        ) {
          const liveJson = findCurationDataJsonById(input.itemId);
          const liveCuration: unknown = liveJson ? JSON.parse(String(liveJson)) : null;
          const liveRecord =
            liveCuration && typeof liveCuration === 'object'
              ? (liveCuration as Record<string, unknown>).listingEvidenceValidation
              : null;
          const liveParsed = ListingEvidenceValidationSchema.safeParse(liveRecord);
          if (liveParsed.success && JSON.stringify(liveParsed.data) === JSON.stringify(prior.record)) {
            return {
              ok: true as const,
              replay: true,
              receiptId: claim.receipt.id,
              record: prior.record,
              resolvedClaimIds: prior.resolvedClaimIds ?? claimIds,
              aggregateStatus: (prior.aggregateStatus ?? prior.record.status ?? 'needs_review') as ListingEvidenceValidation['status'],
            };
          }
        }
      } catch {
        // Corrupt receipt details never replay — fall through and re-verify.
      }
      // Replay-after-edit: the token already completed once but the stored
      // verified record is no longer live (an intervening verification
      // changed it). The original success receipt + audit trail must
      // survive, so refuse WITHOUT failing the existing completed receipt —
      // no write, no mutation, plain 409 for a fresh token retry.
      return {
        ok: false as const,
        code: 'revision_stale' as const,
        reason: 'This action token already verified these claims, but the record changed since (a later verification superseded it); reload the current claim state and verify with a new token.',
        status: 409 as const,
      };
    }
    if (claim.isInterrupted) {
      return {
        ok: false as const,
        code: 'interrupted_command',
        reason: 'A previous verification command was interrupted; retry with a new action token.',
        status: 409,
      };
    }

    // Authoritative guards (inside the transaction, after the replay
    // check): revision binding, currentness, evidence binding, target
    // eligibility, and hard gates. Any refusal fails the claimed receipt
    // (fixable 400/409 must not strand a `started` row forcing a new token)
    // and writes nothing. Completed-replay refusals never reach this block:
    // they return above without touching the existing completed receipt.
    {
      const liveRaw = findCurationDataJsonById(input.itemId);
      const liveCuration: Record<string, unknown> | null = (() => {
        if (!liveRaw) return null;
        try {
          const parsed: unknown = JSON.parse(String(liveRaw));
          if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
        } catch {
          return null;
        }
        return null;
      })();
      if (!liveCuration) {
        return failInside(claim.receipt.id, 'revision_stale', 'The item changed during verification; your input is preserved — reload and resubmit.', 409);
      }
      const liveRecordParsed = ListingEvidenceValidationSchema.safeParse(liveCuration.listingEvidenceValidation);
      if (!liveRecordParsed.success) {
        return failInside(claim.receipt.id, 'record_malformed', 'The listing-evidence record changed during verification; re-run the listing check.', 409);
      }
      const liveRecord = liveRecordParsed.data;
      if (liveRecord.overflow) {
        return failInside(claim.receipt.id, 'record_overflow', 'The listing exceeds the semantic claim bound; narrow it and re-run — overflow cannot be verified.', 409);
      }
      if (currentCurationRevision(liveCuration, currentSourceAuthority(input.itemId)) !== (input.expectedRevision ?? '').trim()) {
        return failInside(claim.receipt.id, 'revision_stale', 'The item changed since you loaded it (listing text or selected source changed); your input is preserved — reload the current claim state and resubmit.', 409);
      }
      const liveCurrent = currentListingEvidenceHashes(input.itemId, liveCuration, {
        workspacePath: undefined,
        workspaceId: input.workspaceId,
      });
      const liveGate = evaluateListingEvidenceGate({
        curationData: liveCuration,
        currentListingHash: liveCurrent.listingHash,
        currentEvidenceHash: liveCurrent.evidenceHash,
        currentModelPolicyDigest: liveCurrent.modelPolicyDigest,
        currentSourceAuthority: liveCurrent.sourceAuthority,
      });
      if (!liveGate.ok && (liveGate.code === 'listing_evidence_stale' || liveGate.code === 'listing_evidence_malformed')) {
        return failInside(claim.receipt.id, 'evidence_stale', liveGate.reason, 409);
      }
      if (input.expectedEvidenceHash !== liveCurrent.evidenceHash || input.expectedEvidenceHash !== liveRecord.evidenceHash) {
        return failInside(claim.receipt.id, 'evidence_stale', 'The evidence bundle changed since you loaded it; your input is preserved — reload the current claim state and resubmit.', 409);
      }
      if (liveRecord.listingHash !== liveCurrent.listingHash || liveRecord.evidenceHash !== liveCurrent.evidenceHash) {
        return failInside(claim.receipt.id, 'evidence_stale', 'The listing-evidence record changed since you loaded it; your input is preserved — reload and resubmit.', 409);
      }
      const liveById: Record<string, ListingEvidenceClaim> = {};
      for (const c of liveRecord.claims) liveById[c.id] = c;
      for (const id of claimIds) {
        const live = liveById[id];
        if (!live) {
          return failInside(claim.receipt.id, 'claim_not_found', `Claim ${id} is not part of the current listing-evidence record.`, 404);
        }
        if (ListingEvidenceClaimSchema.safeParse(live).success === false) {
          return failInside(claim.receipt.id, 'record_malformed', `Claim ${id} is malformed; re-run the listing check.`, 409);
        }
        if (!live.material || (live.verdict !== 'insufficient' && live.verdict !== 'unavailable')) {
          return failInside(claim.receipt.id, 'claim_not_unresolved', `Claim ${id} is ${live.verdict} (producer ${live.producer}) — only unresolved findings can be operator-verified.`, 409);
        }
        const pre = preById[id];
        if (pre && live.claimHash !== pre.claimHash) {
          return failInside(claim.receipt.id, 'evidence_stale', `Claim ${id} changed during verification; your input is preserved — reload and resubmit.`, 409);
        }
      }
      const liveHardRefusal = hardGateRefusal(input.itemId, owned.upc, input.workspaceId, claimIds);
      if (liveHardRefusal) {
        return failInside(claim.receipt.id, 'hard_gate_refusal', liveHardRefusal.reason, 409);
      }
      // Anti-fabrication linkage (after hard gates so ownership refusals
      // keep their owning-flow routing): EVERY resolved claim needs its OWN
      // current, affirmative attestation in the observation
      // (observationSupportsClaim: verbatim whole-token span + verification
      // verb). Quoted text alone never establishes support, and one linked
      // claim never certifies siblings. Value binding: when a live manual
      // attestation exists, each target claim's field/value must match the
      // attestation checklist + current value hashes + live extraction —
      // an attestation over an old title cannot authorize a description
      // claim, and mere existence never bypasses this leg.
      for (const id of claimIds) {
        const live = liveById[id];
        if (!live || !observationSupportsClaim(observation, live.text)) {
          return failInside(claim.receipt.id, 'invalid_observation', `Claim ${id} has no claim-specific attestation in the observation; quote that claim's exact wording AND state what was verified (e.g. "verified … matches") — quoted text alone never establishes support, and one claim never certifies another.`, 400);
        }
        try {
          const attestation = getActiveManualEvidenceAttestationForItem(input.itemId);
          if (attestation && !attestationCoversClaim(attestation.attestation_id, input.itemId, live)) {
            return failInside(claim.receipt.id, 'invalid_observation', `Claim ${id} is not covered by the active manual-evidence attestation's verified values; attest the exact field/value for this claim in the manual-evidence flow.`, 400);
          }
        } catch {
          return failInside(claim.receipt.id, 'invalid_observation', `Claim ${id} cannot be value-bound to manual evidence; re-attest the exact field/value for this claim.`, 400);
        }
      }
    }

    let next: ListingEvidenceValidation;
    try {
      // Re-read inside the transaction: a concurrent edit between the
      // pre-check and the write fails closed (revision + currentness).
      const liveJson = findCurationDataJsonById(input.itemId);
      if (!liveJson) {
        throw Object.assign(new Error('revision changed during verification'), { code: 'revision_stale' });
      }
      const liveCuration: unknown = JSON.parse(String(liveJson));
      if (!liveCuration || typeof liveCuration !== 'object') {
        throw Object.assign(new Error('revision changed during verification'), { code: 'revision_stale' });
      }
      const liveRecordRaw = (liveCuration as Record<string, unknown>).listingEvidenceValidation;
      const liveParsed = ListingEvidenceValidationSchema.safeParse(liveRecordRaw);
      if (!liveParsed.success) {
        throw Object.assign(new Error('The listing-evidence record changed during verification'), { code: 'record_malformed' });
      }
      if (currentCurationRevision(liveCuration as Record<string, unknown>, currentSourceAuthority(input.itemId)) !== (input.expectedRevision ?? '').trim()) {
        throw Object.assign(new Error('revision changed during verification'), { code: 'revision_stale' });
      }

      const now = new Date().toISOString();
      const liveClaims: Record<string, ListingEvidenceClaim> = {};
      for (const c of liveParsed.data.claims) liveClaims[c.id] = c;
      const resolved: Record<string, true> = {};
      for (const id of claimIds) resolved[id] = true;
      const nextClaims: ListingEvidenceClaim[] = liveParsed.data.claims.map((c) => {
        if (!resolved[c.id]) return c;
        const live = liveClaims[c.id]!;
        if (!live.material || (live.verdict !== 'insufficient' && live.verdict !== 'unavailable')) {
          throw Object.assign(new Error(`Claim ${c.id} is no longer unresolved`), { code: 'claim_not_unresolved' });
        }
        if (preById[c.id] && live.claimHash !== preById[c.id]!.claimHash) {
          throw Object.assign(new Error(`Claim ${c.id} changed during verification`), { code: 'evidence_stale' });
        }
        return {
          ...live,
          verdict: 'supported' as const,
          producer: 'operator_verified' as const,
          modelCallId: null,
          reason: `Operator-verified by ${principal.actor} at ${now}: ${observation} [provenance: ${provenance}]`.slice(0, 500),
        };
      });

      // Re-aggregate: verification clears only resolved findings. Remaining
      // unresolved findings stay release-blocking.
      const remainingUnresolved = nextClaims.filter((c) => c.material && (c.verdict === 'insufficient' || c.verdict === 'unavailable' || c.verdict === 'stale'));
      const remainingContradicted = nextClaims.filter((c) => c.material && c.verdict === 'contradicted');
      let status: ListingEvidenceValidation['status'];
      if (liveParsed.data.overflow) status = 'unavailable';
      else if (remainingContradicted.length > 0) status = 'blocked';
      else if (remainingUnresolved.length > 0) status = 'needs_review';
      else status = 'passed';
      const remainingTexts = remainingUnresolved.map((c) => c.text).concat(remainingContradicted.map((c) => c.text));
      const findings = liveParsed.data.findings.filter((f) =>
        remainingTexts.some((t) => f.includes(t.slice(0, 40))),
      );

      next = {
        ...liveParsed.data,
        claims: nextClaims,
        status,
        findings,
        evaluatedAt: now,
        sourceAuthority: currentSourceAuthority(input.itemId),
      };
      const nextParsed = ListingEvidenceValidationSchema.safeParse(next);
      if (!nextParsed.success) {
        throw Object.assign(new Error('Verified record failed validation'), { code: 'record_malformed' });
      }
      next = nextParsed.data;

      updateItemCurationData(
        input.itemId,
        JSON.stringify({ ...(liveCuration as Record<string, unknown>), listingEvidenceValidation: next }),
      );

      // Consequential resolution invalidates prior review/approval — the
      // released output changed (operator verdicts are release authority).
      try {
        markReviewInvalidated(input.itemId, 'listing evidence operator verification');
      } catch {
        // Review table absence (minimal DBs) never blocks verification.
      }
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      const message = err instanceof Error ? err.message : 'verification failed';
      if (
        code === 'revision_stale' ||
        code === 'evidence_stale' ||
        code === 'record_malformed' ||
        code === 'claim_not_unresolved' ||
        code === 'claim_not_found'
      ) {
        try {
          failReceipt(claim.receipt.id, JSON.stringify({ code, message }));
        } catch {
          /* best-effort */
        }
        const status = code === 'claim_not_found' ? 404 : 409;
        return { ok: false as const, code: code as ListingVerifyRejectCode, reason: message, status };
      }
      throw err;
    }

    completeReceipt(
      claim.receipt.id,
      JSON.stringify({
        resolvedClaimIds: claimIds,
        claimHashes: preTargets.map((c) => c.claimHash),
        evidenceHash: input.expectedEvidenceHash,
        listingHash: preRecord.listingHash,
        expectedRevision: (input.expectedRevision ?? '').trim(),
        observationHash: shaHex(observation),
        provenanceHash: shaHex(provenance),
        principal: principal.actor,
        itemId: input.itemId,
        record: next,
        aggregateStatus: next.status,
      }),
    );

    try {
      addAuditLog({
        workspaceId: input.workspaceId,
        entityType: 'onboarding_item',
        entityId: input.itemId,
        action: 'verify_listing_evidence',
        message: `Operator ${principal.actor} verified ${claimIds.length} listing claim(s) (${claimIds.join(', ')}) for ${owned.upc}`,
        detailsJson: JSON.stringify({
          claimIds,
          claimHashes: preTargets.map((c) => c.claimHash),
          evidenceHash: input.expectedEvidenceHash,
          listingHash: preRecord.listingHash,
          observation,
          provenance,
          aggregateStatus: next.status,
        }),
      });
    } catch (auditErr) {
      // Audit failure rolls back the transaction via throw below.
      throw new Error(`audit write failed: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`, { cause: auditErr });
    }

    return {
      ok: true as const,
      replay: false,
      receiptId: claim.receipt.id,
      record: next,
      resolvedClaimIds: claimIds,
      aggregateStatus: next.status,
    };
  });

  type TxOutcome =
    | { ok: true; replay: boolean; receiptId: string; record: ListingEvidenceValidation; resolvedClaimIds: string[]; aggregateStatus: ListingEvidenceValidation['status'] }
    | { ok: false; code: ListingVerifyRejectCode; reason: string; status: number };
  const outcome = run() as TxOutcome;
  if (!outcome.ok) return outcome;
  return { ok: true as const, replay: outcome.replay, receiptId: outcome.receiptId, record: outcome.record, resolvedClaimIds: outcome.resolvedClaimIds, aggregateStatus: outcome.aggregateStatus };
}

/** Read-only expected-revision token for the current curation (route helper).
 * Never null: corrupt/missing curation hashes the null canonical so the GET
 * always emits a submittable token. Null can never satisfy the POST
 * `min(1)` schema (non-blocker 5), and a null token would strand the panel
 * with no actionable refusal. A stale token still fails closed at the
 * revision guard with 409 `revision_stale` and preserved input.
 * Composite: curation JSON + live source authority (issue #367 gap 5), so
 * a source_url change rotates the token even when curation is untouched.
 */
export function currentVerifyRevisionForItem(itemId: string): string {
  try {
    const authority = currentSourceAuthority(itemId);
    const raw = findCurationDataJsonById(itemId);
    if (!raw) return currentCurationRevision(null, authority);
    const parsed: unknown = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object') return currentCurationRevision(null, authority);
    return currentCurationRevision(parsed as Record<string, unknown>, authority);
  } catch {
    return currentCurationRevision(null);
  }
}
