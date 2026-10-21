/**
 * Listing-Evidence Claim Units + Deterministic Checks (issue #366).
 *
 * Pure module. Claim units are BUILT IN CODE from the final projected
 * listing (title, description sentences/bullets, included variant facts)
 * with offsets and qualifiers preserved — never a generative claim
 * extractor, never unprojected text, never the whole catalog.
 *
 * Deterministic checks run FIRST: citation/span existence, eligibility /
 * currentness / SKU-source linkage, resolved hard conflicts, exact
 * identifiers, quantities/units, and variant consistency. Exact supported
 * structured copies need no semantic call; a model can never overrule a
 * concrete contradiction or wrong identity.
 *
 * Eligible evidence only (SKU-local, current generation, non-conflicted):
 * sibling, stale, other-variant, unlinked, and tampered sources refuse
 * deterministically. Distributor-record checks run in Curation against the
 * read-only materialized evidence; Extraction stays URL-null/profile-free.
 */
import { createHash } from 'node:crypto';
import type { ClassificationEvidence } from '../shared/schemas/classification';
import type { ListingEvidenceClaim } from '../shared/schemas/onboarding';

// ─── Versions ────────────────────────────────────────────────────────────────

/** Deterministic rule version for listing-evidence checks (single source). */
export const LISTING_EVIDENCE_RULES_VERSION = 'listing-evidence-rules-v1';

/** Maximum semantic claim units per listing (parent spec bound). */
export const LISTING_EVIDENCE_MAX_CLAIMS = 24;

// ─── Final listing input ─────────────────────────────────────────────────────

/**
 * The exact final projected listing that would be released: final title
 * (curated → extraction → register fallbacks), description sentences /
 * bullets (curated → verified extraction → manual corrections), and the
 * included variant/measurement facts (structured, not prose).
 */
export interface FinalListingInput {
  title: string | null;
  description: string | null;
  /** Included material variant/measurement facts (axis → value). */
  variantFacts: Record<string, string>;
  /** Configured requiredness: which fields must be present. */
  requiredFields: string[];
}

/** One eligible evidence record with linkage metadata. */
export interface EligibleEvidence {
  evidence: ClassificationEvidence;
  /** Canonical text value for matching (value or snippet). */
  text: string;
  /** Lower-cased source field. */
  sourceField: string;
}

/** Built claim unit awaiting verdict. */
export interface BuiltClaim {
  id: string;
  field: 'title' | 'description' | 'variant';
  span: [number, number];
  text: string;
  claimHash: string;
  material: boolean;
}

// ─── Text splitting (code-owned, no generation) ─────────────────────────────

function shaHex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Split description into sentence/bullet units with offsets (code only). */
function splitDescriptionUnits(description: string): Array<{ text: string; span: [number, number] }> {
  const units: Array<{ text: string; span: [number, number] }> = [];
  // Bullets first: lines starting with -, *, •, or numbered markers.
  const lines = description.split('\n');
  let offset = 0;
  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1; // +1 for the newline
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.+?)\s*$/.exec(line);
    if (bullet && bullet[1]) {
      const text = bullet[1].trim();
      if (text) {
        const innerStart = lineStart + line.indexOf(bullet[1]);
        units.push({ text, span: [innerStart, innerStart + bullet[1].length] });
      }
      continue;
    }
    // Sentence split on . ! ? followed by space/case boundary — keep units.
    const trimmed = line.trim();
    if (!trimmed) continue;
    const base = lineStart + line.indexOf(trimmed);
    const sentences = trimmed.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [trimmed];
    let cursor = 0;
    for (const sentence of sentences) {
      const text = sentence.trim();
      if (!text) {
        cursor += sentence.length;
        continue;
      }
      const start = base + trimmed.indexOf(text, cursor);
      units.push({ text, span: [start, start + text.length] });
      cursor = trimmed.indexOf(text, cursor) + text.length;
    }
  }
  return units;
}

/**
 * Oversized-unit bound (issue #366 gap 3): a single sentence/bullet longer
 * than this bound cannot be evaluated completely (semantic questions carry
 * only a truncated prefix), so the listing fails closed instead of
 * certifying truncated text. Kept in this module so the service and the
 * test-only harness share one bound.
 */
export const LISTING_EVIDENCE_MAX_UNIT_CHARS = 1000;

/**
 * Build claim units in code from the final projected listing.
 * - Title: one claim over the whole title (with offsets preserved).
 * - Description: one claim per sentence/bullet (offsets preserved).
 * - Variant facts: one claim per included axis=value fact.
 * Absent optional fields produce NO claim (nonblocking); included text
 * always claims. Deterministic, bounded; overflow flagged (never clipped
 * silently — caller fails closed).
 * - Oversized units (a single sentence/bullet/title over
 *   LISTING_EVIDENCE_MAX_UNIT_CHARS) set `oversized`: the caller fails
 *   closed (unavailable/blocked) rather than certifying truncated text.
 */
export function buildClaimUnits(input: FinalListingInput): { claims: BuiltClaim[]; overflow: boolean; oversized: boolean } {
  const titleRequired = input.requiredFields.includes('title');
  const descriptionRequired = input.requiredFields.includes('description');
  const built: BuiltClaim[] = [];
  let ordinal = 0;
  let oversized = false;
  const nextId = () => `claim_${String(++ordinal).padStart(2, '0')}`;

  const title = typeof input.title === 'string' && input.title.trim() ? input.title : null;
  if (title) {
    const text = title.trim();
    if (text.length > LISTING_EVIDENCE_MAX_UNIT_CHARS) oversized = true;
    built.push({
      id: nextId(),
      field: 'title',
      span: [title.indexOf(text), title.indexOf(text) + text.length],
      text,
      claimHash: shaHex(text.toLowerCase()),
      material: true,
    });
  } else if (titleRequired) {
    // Missing required title: no empty-text claim is persisted (the claim
    // schema requires min(1) text). The deterministic check reports
    // contradicted-by-absence against a sentinel so the gate blocks with
    // `blocked` (missing required text) rather than `malformed`.
    built.push({
      id: nextId(),
      field: 'title',
      span: [0, 0],
      text: '[missing required title]',
      claimHash: shaHex(''),
      material: true,
    });
  }

  const description = typeof input.description === 'string' && input.description.trim() ? input.description : null;
  if (description) {
    for (const unit of splitDescriptionUnits(description)) {
      if (unit.text.length > LISTING_EVIDENCE_MAX_UNIT_CHARS) oversized = true;
      built.push({
        id: nextId(),
        field: 'description',
        span: unit.span,
        text: unit.text,
        claimHash: shaHex(unit.text.toLowerCase()),
        material: true,
      });
    }
  } else if (descriptionRequired) {
    // Same sentinel discipline as the missing-title leg above: never
    // persist empty text (schema min(1)); the deterministic check maps
    // the sentinel to contradicted-by-absence.
    built.push({
      id: nextId(),
      field: 'description',
      span: [0, 0],
      text: '[missing required description]',
      claimHash: shaHex(''),
      material: true,
    });
  }

  for (const [axis, value] of Object.entries(input.variantFacts)) {
    if (typeof value !== 'string' || !value.trim()) continue; // absent optional ⇒ no claim
    const text = `${axis}: ${value.trim()}`;
    // Variant facts are structured codes, not prose: an absurdly long value
    // trips the same fail-closed oversized leg (it cannot be evaluated).
    if (text.length > LISTING_EVIDENCE_MAX_UNIT_CHARS) oversized = true;
    built.push({
      id: nextId(),
      field: 'variant',
      span: [0, 0],
      text,
      claimHash: shaHex(text.toLowerCase()),
      material: true,
    });
  }

  const overflow = built.length > LISTING_EVIDENCE_MAX_CLAIMS;
  return { claims: built, overflow, oversized };
}

 /** Hash the exact final projected listing (title + description + facts).
 * Whitespace-normalized (trimmed): whitespace-only edits that change no
 * claim produce the same hash, so they never stale a valid record.
 */
 export function hashFinalListing(input: FinalListingInput): string {
   return shaHex(
     JSON.stringify({
       title: typeof input.title === 'string' ? input.title.trim() || null : null,
       description: typeof input.description === 'string' ? input.description.trim() || null : null,
       variantFacts: Object.fromEntries(
         Object.entries(input.variantFacts)
           .filter(([, v]) => typeof v === 'string' && v.trim())
           .map(([k, v]) => [k.trim(), (v as string).trim()])
           .sort(([a], [b]) => (a < b ? -1 : 1)),
       ),
       // Gap 6: requiredness is hashed so an optional→required flip
       // changes the hash (fail closed) even when the prose is identical.
       requiredFields: [...input.requiredFields].sort(),
     }),
   );
 }

// ─── Eligibility (deterministic) ─────────────────────────────────────────────

/**
 * Filter to eligible SKU-local evidence: same product SKU, current run
 * (caller supplies only this run's rows), non-conflicted reliability.
 * Unlinked (other-SKU), sibling, stale, tampered, and conflicting rows
 * are excluded — they can never support or contradict here.
 */
export function eligibleEvidenceFor(
  allEvidence: ClassificationEvidence[],
  sku: string,
): EligibleEvidence[] {
  const out: EligibleEvidence[] = [];
  for (const evidence of allEvidence) {
    if (evidence.productSku !== sku) continue; // sibling/other-variant/unlinked
    if (evidence.reliability === 'conflicting') continue; // unresolved hard conflict
    if (evidence.reliability === 'unknown') continue; // tampered/divergent
    const text = typeof evidence.value === 'string' ? evidence.value : (evidence.snippet ?? '');
    if (!text.trim()) continue; // no citation/span content
    out.push({
      evidence,
      text: text.trim(),
      sourceField: (evidence.sourceField ?? '').toLowerCase(),
    });
  }
  return out;
}

/** Hash the eligible evidence bundle (ids + values, sorted). */
export function hashEvidenceBundle(eligible: EligibleEvidence[]): string {
  const rows = eligible
    .map(e => ({ id: e.evidence.id, text: e.text }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return shaHex(JSON.stringify(rows));
}
/** Bind the evaluator's eligible claim evidence to the exact accepted snapshot revision. */
export function hashAcceptedEvidenceBundle(acceptedSnapshotHash: string, eligible: EligibleEvidence[]): string {
  return shaHex(JSON.stringify({
    acceptedSnapshotHash,
    eligibleEvidenceHash: hashEvidenceBundle(eligible),
  }));
}


/**
 * Fail-closed oversized-unit records (issue #366 gap 3): at least one claim
 * unit exceeds LISTING_EVIDENCE_MAX_UNIT_CHARS, so the full material content
 * was never evaluated. Records every claim as `unavailable` (never a
 * partial all-clear) with blocking status at the caller.
 */
export function oversizedUnavailableRecords(
  claims: BuiltClaim[],
  eligible: EligibleEvidence[],
  reason: string,
): ListingEvidenceClaim[] {
  return claims.map(c => ({
    id: c.id,
    field: c.field,
    span: c.span,
    text: c.text.slice(0, 2000),
    claimHash: c.claimHash,
    material: c.material,
    verdict: 'unavailable' as const,
    producer: 'unavailable' as const,
    evidenceConsidered: eligible.map(e => e.evidence.id).sort(),
    modelCallId: null,
    reason: reason.slice(0, 500),
  }));
}

// ─── Deterministic matchers ──────────────────────────────────────────────────

const NEGATION_RE = /\b(not|no|never|n't|without|unsuitable|inappropriate|free of|contains no)\b/i;

/** Normalize a quantity string for exact comparison (units + numbers). */
export function normalizeQuantity(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.,;:()"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(\d)\s*(oz|ounces?|lb|lbs?|pounds?|g|grams?|kg|kilograms?|ct|counts?|pk|packs?|ml|fl\s*oz)\b/g, '$1$2')
    .replace(/\bounces?\b/g, 'oz')
    .replace(/\bpounds?\b/g, 'lb')
    .replace(/\bgrams?\b/g, 'g')
    .replace(/\bkilograms?\b/g, 'kg')
    .replace(/\bcounts?\b/g, 'ct')
    .replace(/\bpacks?\b/g, 'pk');
}

/** Extract quantity-like tokens from text for exact comparison. */
function quantityTokens(text: string): string[] {
  const matches = text.toLowerCase().match(/\d+(?:\.\d+)?\s*(?:oz|ounces?|lb|lbs?|pounds?|g|grams?|kg|kilograms?|ct|counts?|pk|packs?|ml|fl\s*oz)\b/gi) ?? [];
  return matches.map(normalizeQuantity);
}

/** Extract identifier-like tokens (UPC digits, model numbers) from text. */
function identifierTokens(text: string): string[] {
  const matches = text.match(/\b\d{8,14}\b|[A-Z0-9]+[-_][A-Z0-9-]+/gi) ?? [];
  return matches.map(s => s.toLowerCase());
}

/** Token set for whole-statement support checks (stopword-light). */
function contentTokens(text: string): Set<string> {
  const stop = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'for', 'with', 'in', 'on', 'to', 'is', 'are', 'it', 'this', 'that']);
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1 && !stop.has(t)),
  );
}
/** Normalize text for containment comparison (case/punctuation/whitespace-insensitive). */
function normalizeForContainment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Quantity-aware: `5LB` normalizes to `5lb` upstream while titles carry
    // `5 lb` — join digit/unit spacing so single-source containment uses the
    // same approved unit rule as quantity comparison (never certifies by
    // union; still requires one source to contain every assertion).
    .replace(/(\d)\s*(oz|ounces|lb|lbs|pounds|g|grams|kg|kilograms|ct|counts|pk|packs|ml)\b/g, '$1$2');
}

/** Split a claim block into assertion sentences (code-owned, no generation). */
function splitClaimAssertions(text: string): string[] {
  const parts = text.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [text];
  return parts.map(p => normalizeForContainment(p)).filter(p => p.length > 0);
}


export type DeterministicVerdict =
  | { verdict: 'supported'; reason: string }
  | { verdict: 'contradicted'; reason: string }
  | { verdict: 'unresolved'; reason: string };

/**
 * Deterministic claim check in code. Order:
 * 1. Empty material claim (missing required text) → contradicted-by-absence.
 * 2. Exact identifier mismatch (claim carries an identifier no eligible
 *    evidence carries) → contradicted (identity cannot be overruled).
 * 3. Quantity mismatch (claim quantity tokens absent from the bundle while
 *    the bundle carries a DIFFERENT quantity for the same axis) →
 *    contradicted; exact quantity presence → supported.
 * 4. Negation reversal (evidence asserts the positive while the claim
 *    negates, or vice versa) → contradicted.
 * 5. Single-source support (every content token of the claim present in ONE
 *    eligible record of matching negation polarity) → supported. A composite
 *    whose tokens are scattered across records no single source states is
 *    unresolved, never certified by the union.
 * 6. Otherwise unresolved (needs the bounded semantic Choice).
 * One matching clause never certifies a multi-assertion block: support
 * requires every content token covered by one source.
 */
export function deterministicClaimCheck(
  claim: BuiltClaim,
  eligible: EligibleEvidence[],
): DeterministicVerdict {
  if (!claim.text.trim() || claim.text === '[missing required title]' || claim.text === '[missing required description]') {
    return { verdict: 'contradicted', reason: 'Required listing text is missing; the claim asserts nothing verifiable.' };
  }
  if (eligible.length === 0) {
    return { verdict: 'unresolved', reason: 'No eligible current SKU-local evidence; semantic judgment required.' };
  }

  const bundleLower = eligible.map(e => e.text.toLowerCase()).join('\n');

  // 2. Exact identifiers: a claim identifier absent from the whole bundle
  // contradicts (wrong identity); presence alone does not support.
  const claimIds = identifierTokens(claim.text);
  if (claimIds.length > 0) {
    const bundleIds = new Set(identifierTokens(bundleLower));
    const missing = claimIds.filter(id => !bundleIds.has(id));
    if (missing.length > 0) {
      return {
        verdict: 'contradicted',
        reason: `Identifier "${missing[0]}" appears in the listing but in no eligible evidence for this SKU.`,
      };
    }
  }

  // 3. Quantities/units (variant facts + embedded quantities).
  const claimQuantities = quantityTokens(claim.text);
  if (claimQuantities.length > 0) {
    const bundleQuantities = new Set<string>();
    for (const e of eligible) {
      for (const q of quantityTokens(e.text)) bundleQuantities.add(q);
    }
    const allPresent = claimQuantities.every(q => bundleQuantities.has(q));
    if (allPresent) {
      // Exact supported structured copy — but only `supported` when the
      // REST of the claim is also covered (fall through to whole-statement).
    } else {
      // The bundle carries quantity evidence but a different value, or no
      // quantity at all while the claim asserts one.
      const bundleHasAnyQuantity = bundleQuantities.size > 0;
      if (bundleHasAnyQuantity) {
        return {
          verdict: 'contradicted',
          reason: `Quantity "${claimQuantities.find(q => !bundleQuantities.has(q))}" contradicts the evidenced quantity.`,
        };
      }
      return { verdict: 'unresolved', reason: 'Claim quantity has no eligible quantity evidence; semantic judgment required.' };
    }
  }

  // 4. Negation/qualifier check: a claim negation whose positive form is
  // evidenced (or vice versa) contradicts. Compare against each record.
  const claimNegated = NEGATION_RE.test(claim.text);
  if (claimNegated) {
    const positiveForm = claim.text.replace(NEGATION_RE, ' ').toLowerCase();
    const positiveTokens = contentTokens(positiveForm);
    for (const e of eligible) {
      if (NEGATION_RE.test(e.text)) continue;
      const evidenceTokens = contentTokens(e.text);
      const overlap = [...positiveTokens].filter(t => evidenceTokens.has(t));
      // Evidence asserts the positive with substantial overlap while the
      // claim negates → contradiction.
      if (positiveTokens.size > 0 && overlap.length / positiveTokens.size >= 0.6) {
        return {
          verdict: 'contradicted',
          reason: 'Listing negates an assertion the eligible evidence affirms.',
        };
      }
    }
  } else {
    // Claim is positive: evidence that negates the same content contradicts.
    const claimTokens = contentTokens(claim.text);
    for (const e of eligible) {
      if (!NEGATION_RE.test(e.text)) continue;
      const evidenceTokens = contentTokens(e.text.replace(NEGATION_RE, ' '));
      const overlap = [...claimTokens].filter(t => evidenceTokens.has(t));
      if (claimTokens.size > 0 && overlap.length / claimTokens.size >= 0.6) {
        return {
          verdict: 'contradicted',
          reason: 'Eligible evidence negates an assertion the listing affirms.',
        };
      }
    }
  }

  // Variant-axis consistency: a variant-fact claim whose axis value differs
  // from an eligible same-axis record contradicts.
  if (claim.field === 'variant') {
    const axis = claim.text.split(':')[0]?.trim().toLowerCase() ?? '';
    const value = claim.text.split(':').slice(1).join(':').trim().toLowerCase();
    if (axis && value) {
      for (const e of eligible) {
        if (e.sourceField !== axis && !e.sourceField.includes(axis) && !axis.includes(e.sourceField)) continue;
        const evNorm = normalizeQuantity(e.text);
        const claimNorm = normalizeQuantity(value);
        if (evNorm && claimNorm && evNorm !== claimNorm && !evNorm.includes(claimNorm) && !claimNorm.includes(evNorm)) {
          return {
            verdict: 'contradicted',
            reason: `Variant ${axis} "${value}" contradicts evidenced "${e.text.slice(0, 120)}".`,
          };
        }
      }
    }
  }

  // 5. Single-source support: EVERY assertion sentence of the claim block
  // contained (normalized) in ONE eligible record of matching negation
  // polarity. Token-bag overlap is NOT support: reordered assertions across
  // sources ("Dogs eat chicken. Cats eat fish." must not certify "Cats eat
  // chicken.") stay unresolved for semantic judgment. Only an exact
  // structured copy (or single-record assertion-preserving containment)
  // resolves deterministically.
  const claimAssertions = splitClaimAssertions(claim.text);
  const claimNegatedForSupport = NEGATION_RE.test(claim.text);
  if (claimAssertions.length > 0) {
    for (const candidate of eligible) {
      if (NEGATION_RE.test(candidate.text) !== claimNegatedForSupport) continue;
      const candidateNorm = normalizeForContainment(candidate.text);
      if (!candidateNorm) continue;
      const padded = ` ${candidateNorm} `;
      const everyContained = claimAssertions.every(a => padded.includes(` ${a} `) || candidateNorm === a);
      if (everyContained) {
        return { verdict: 'supported', reason: 'Every assertion in the block is contained in one eligible SKU-local record.' };
      }
    }
  }

  // 6. Partial or scattered support is not support.
  return { verdict: 'unresolved', reason: 'Partial or no deterministic coverage; semantic judgment required.' };
}

/** Shape a verdict into the persisted per-claim record (deterministic producer). */
export function toDeterministicClaimRecord(
  claim: BuiltClaim,
  result: DeterministicVerdict,
  eligible: EligibleEvidence[],
): ListingEvidenceClaim {
  return {
    id: claim.id,
    field: claim.field,
    span: claim.span,
    text: claim.text.slice(0, 2000),
    claimHash: claim.claimHash,
    material: claim.material,
    verdict: result.verdict === 'supported' ? 'supported' : result.verdict === 'contradicted' ? 'contradicted' : 'insufficient',
    producer: 'deterministic',
    evidenceConsidered: eligible.map(e => e.evidence.id).sort(),
    modelCallId: null,
    reason: result.reason.slice(0, 500),
  };
}
