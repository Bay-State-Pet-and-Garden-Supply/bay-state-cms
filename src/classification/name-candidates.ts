/**
 * Evidence-backed name candidates (issue #365).
 *
 * Deterministic, DB-free candidate construction from a SKU's ELIGIBLE
 * evidence only. Both the singleton name-consolidation stage and the cohort
 * member path build candidates through this module, so batching never
 * changes factual correctness.
 *
 * Eligibility contract: the caller supplies only evidence eligible for THIS
 * sku — register text, confirmed official evidence, accepted distributor
 * data, existing OCR results, and current operator-attested observations.
 * This module never fetches, enriches, or runs OCR; absence of evidence is
 * an abstention signal, never invention.
 *
 * Conflict contract: conflicting package sizes are never unioned into one
 * title, and shipping weight never replaces net contents. Unresolved
 * identity/source/variant conflicts surface as `conflict` outcomes that
 * stay actionable — never named away.
 *
 * Normalization contract: candidates carry exact source spans plus approved
 * conservative normalization only (the shared abbreviation / attached-size /
 * unit / whitespace rules in `title-prompt-template` and
 * `formatDeterministicTitle`). Brand-first house style and quantity-last
 * detail are enforced at assembly; Brand field ownership never changes.
 */

import {
  ensureBrandInTitle,
  extractProtectedTokens,
  normalizeProtectedToken,
  variantTokenPresentInTitle,
} from '../onboarding/title-prompt-template';
import type { AcceptedItemEvidence } from '../shared/schemas/item-evidence';
import { formatDeterministicTitle } from '../onboarding/cohort-name-coordinator';
/** Approved normalization rule version for name candidates (single-sourced here; persisted into inputHash + normalizationVersion). */
export const NAME_NORMALIZATION_VERSION = 'name-normalization-v2-applicable-variant';

 /** Maximum complete candidates offered to typed selection. */
 export const MAX_NAME_CANDIDATES = 16;

export type NameEvidenceChannel =
  | 'register'
  | 'official'
  | 'distributor'
  | 'retailer'
  | 'ocr'
  | 'manual';

export interface NameEvidenceText {
  /** Eligible channel this text came from. */
  channel: NameEvidenceChannel;
  /** Exact source span (raw text as evidenced). */
  span: string;
  /** Evidence id backing the span (empty when the caller has none). */
  evidenceId?: string;
  /**
   * Semantic kind for structured identity components. Attribute-only values
   * can complete a real product body but never create a name by themselves.
   */
  kind?: 'species' | 'form' | 'flavor' | 'formula' | 'recipe' | 'lifestage' | 'material' | 'color' | 'pack_count' | 'strength';
}

export interface NameCandidateInput {
  /** Complete candidate title text (normalized). */
  title: string;
  /** Exact source spans / raw components the candidate was built from. */
  components: string[];
  /** Evidence ids backing this candidate. */
  evidenceIds: string[];
}

export type NameCandidateOutcome =
  | { kind: 'candidates'; candidates: NameCandidateInput[]; overflow: boolean }
  | { kind: 'conflict'; reason: string; conflictingTokens: string[] }
  | { kind: 'missing'; reason: string };

/**
 * Normalize one raw span with the approved conservative rules only:
 * attached-size expansion, abbreviation expansion, unit normalization,
 * whitespace cleanup, and deterministic casing via the shared formatter.
 * The formatter is brand-agnostic here (brand assembly happens in
 * `assembleCandidate`); callers pass null so no brand is invented.
 */
function normalizeSpan(span: string): string {
  let normalized = formatDeterministicTitle(span, null);
  const modelTokens = span.match(/\b[A-Z]{2,}(?:[-/][A-Z0-9]+|\d[A-Z0-9]*)+\b/g) ?? [];
  for (const token of modelTokens) {
    const index = normalized.toLocaleLowerCase().indexOf(token.toLocaleLowerCase());
    if (index >= 0) normalized = `${normalized.slice(0, index)}${token}${normalized.slice(index + token.length)}`;
  }
  const negation = /\b(?:not|no|never|without|avoid(?:s|ed)?|cannot|can't|won't|don't|doesn't|isn't|aren't|shouldn't|mustn't)\b[\s\S]*$/i.exec(span);
  if (negation) {
    const formattedNegation = formatDeterministicTitle(negation[0], null);
    const index = normalized.toLocaleLowerCase().lastIndexOf(formattedNegation.toLocaleLowerCase());
    if (index >= 0) normalized = `${normalized.slice(0, index)}${negation[0]}${normalized.slice(index + formattedNegation.length)}`;
  }
  return normalized;
}

function isShippingWeightSpan(span: string): boolean {
  return /\bship\w*\s+wt\b|\bship\w*\s+weight\b|\bshipping\s+weight\b|\bgross\s+wt\b/i.test(span);
}

/**
 * Collect net-content tokens vs shipping-weight tokens. Shipping weight is
 * evidence of the parcel, never of the product — it must never replace net
 * contents in a candidate title.
 */
function splitNetVsShipping(spans: NameEvidenceText[]): {
  netTokens: string[];
  shippingTokens: string[];
} {
  const netTokens: string[] = [];
  const shippingTokens: string[] = [];
  for (const span of spans) {
    for (const token of extractProtectedTokens(span.span)) {
      const normalized = normalizeProtectedToken(token);
      if (isShippingWeightSpan(span.span)) {
        if (!shippingTokens.some(t => t.toLowerCase() === normalized.toLowerCase())) {
          shippingTokens.push(normalized);
        }
      } else if (!netTokens.some(t => t.toLowerCase() === normalized.toLowerCase())) {
        netTokens.push(normalized);
      }
    }
  }
  return { netTokens, shippingTokens };
}

/**
 * Detect unresolved conflicting package sizes: two or more DISTINCT
 * quantities on the SAME dimension (mass vs mass, volume vs volume,
 * count vs count, size vs size). Mass (oz, lb, g, kg) and volume
 * (fl oz, ml, gal, qt, ltr) are separate dimensions — a weight +
 * capacity pair (e.g. `5 lb` + `1 gal`) never conflicts, and unit-converted
 * equivalents on one dimension (5 lb vs 80 oz; 1 gal vs 4 qt) compare
 * equal. Cross-dimension numerics (`16 fl oz` vs `1 lb`) never union.
 */
/**
 * Convert a normalized quantity token to a canonical base amount on its own
 * dimension — mass in ounces, volume in fluid ounces — so unit-converted
 * equivalents (5 lb vs 80 oz; 1 gal vs 4 qt) compare equal instead of
 * conflicting, while cross-dimension pairs (16 fl oz vs 1 lb; 5 lb vs
 * 6-pack) never compare at all. Returns null for non-convertible tokens
 * (counts, sizes).
 */
function massOunces(normalized: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*(oz|lb|g|kg)\b/i.exec(normalized);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isFinite(num)) return null;
  const unit = m[2].toLowerCase();
  const factor = unit === 'oz' ? 1 : unit === 'lb' ? 16 : unit === 'g' ? 1 / 28.349523125 : 1000 / 28.349523125;
  return num * factor;
}
function volumeFluidOunces(normalized: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*(fl oz|ml|gal|qt|ltr|liter|litre)\b/i.exec(normalized);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isFinite(num)) return null;
  const unit = m[2].toLowerCase();
  const factor =
    unit === 'fl oz' ? 1
    : unit === 'ml' ? 1 / 29.5735295625
    : unit === 'gal' ? 128
    : unit === 'qt' ? 32
    : 33.814022701843; // ltr/liter/litre
  return num * factor;
}
const COLOR_SPAN_PATTERN = /\b(red|blue|green|black|white|pink|purple|brown|gray|grey|navy|teal|beige|cream|ivory|orange|yellow|silver|gold|charcoal|lavender|tan|maroon|burgundy|olive|aqua|cyan|magenta|violet|indigo|turquoise|khaki|coral|salmon|peach|mint|lime|lemon|chocolate|caramel|honey|amber|copper|bronze|platinum|graphite|slate|stone|camo|camouflage|multi|multicolor|assorted)\b/i;
/**
 * Species identity words (issue #365 contradiction check): the closed pet/
 * animal domain from the species-guard incompatibility table plus common
 * pet species and life-stage-prefixed young (puppy/kitten). Multi-word
 * entries match as phrases. An evidenced OCR species that appears nowhere
 * in the title while a DIFFERENT species word does is an identity conflict
 * (fail closed), never a silent naming over contradicted evidence.
 */
export const SPECIES_IDENTITY_WORDS = [
  'dog', 'puppy', 'cat', 'kitten', 'fish', 'betta', 'goldfish', 'koi', 'guppy',
  'bird', 'parrot', 'parakeet', 'cockatiel', 'canary', 'finch', 'dove',
  'reptile', 'turtle', 'tortoise', 'lizard', 'gecko', 'bearded dragon',
  'snake', 'frog', 'toad', 'horse', 'pony', 'rabbit', 'bunny', 'ferret',
  'hamster', 'gerbil', 'guinea pig', 'mouse', 'rat', 'chinchilla', 'hedgehog',
  'chicken', 'turkey', 'duck', 'goose', 'quail', 'livestock', 'cattle', 'cow',
  'pig', 'goat', 'sheep', 'small animal', 'small pet', 'wild bird', 'wildlife',
  'farm animal', 'caged bird',
];
/**
 * Reject evidence spans that contain only measurements, brand/color words,
 * a lone variant token, or explicitly typed identity attributes. Typed
 * attributes supply completion detail to genuine product-name bodies; they
 * never stand as bodies by themselves, so a flavor cannot mint a title such
 * as `Acme Chicken 12 oz` without a product identity.
 */
function isAttributeOnlySpan(span: string, brand: string | null, kind?: NameEvidenceText['kind']): boolean {
  if (kind !== undefined) return true;
  if (isMeasurementOnlySpan(span, brand)) return true;
  const normalized = normalizeSpan(span);
  let rest = normalized;
  for (const token of extractProtectedTokens(normalized)) {
    rest = rest.split(token).join(' ');
  }
  rest = rest.replace(COLOR_SPAN_PATTERN, ' ');
  if (brand?.trim()) {
    for (const word of brand.trim().split(/[^a-z0-9]+/i).filter(Boolean)) {
      rest = rest.replace(new RegExp(`\\b${escapeRegExpLiteral(word)}\\b`, 'gi'), ' ');
    }
  }
  return rest.replace(/[^a-z0-9]+/gi, '').length === 0;
}
/**
 * Classify a normalized quantity token into its comparison dimension.
 * Mass and volume are separate dimensions (a weight + capacity pair never
 * conflicts); everything else falls through to a literal dimension key.
 */
function tokenDimension(normalized: string): string {
  if (massOunces(normalized) !== null) return 'mass';
  if (volumeFluidOunces(normalized) !== null) return 'volume';
  return `literal:${normalized.toLowerCase()}`;
}
function sizeIdentityKey(normalized: string): string {
  const dim = tokenDimension(normalized);
  if (dim === 'mass') {
    const ounces = massOunces(normalized);
    if (ounces !== null) return `mass:${Math.round(ounces * 1000)}`;
  }
  if (dim === 'volume') {
    const flOz = volumeFluidOunces(normalized);
    if (flOz !== null) return `volume:${Math.round(flOz * 1000)}`;
  }
  return `${dim}:${normalized.toLowerCase()}`;
}
function findSizeConflict(netTokens: string[]): string[] {
  const seenByDimension = new Map<string, Map<string, string>>();
  for (const token of netTokens) {
    const normalized = normalizeProtectedToken(token);
    const dim = tokenDimension(normalized);
    let seen = seenByDimension.get(dim);
    if (!seen) { seen = new Map(); seenByDimension.set(dim, seen); }
    const key = sizeIdentityKey(normalized);
    if (!seen.has(key)) seen.set(key, normalized);
  }
  const conflicts: string[] = [];
  for (const seen of seenByDimension.values()) {
    if (seen.size > 1) conflicts.push(...seen.values());
  }
  return conflicts;
}

/**
 * Assemble one complete candidate: brand first, normalized body, required
 * quantity-last detail. Returns null when the body carries no substance
 * beyond the brand (never a brand-only invention).
 */
function assembleCandidate(body: string, brand: string | null, quantityTokens: string[], requiredDetails: string[] = []): string | null {
  let title = body.trim().replace(/\s+/g, ' ');
  if (!title) return null;
  if (brand?.trim()) title = ensureBrandInTitle(title, brand);
  for (const detail of requiredDetails) {
    if (!title.toLowerCase().includes(detail.toLowerCase())) title = `${title} ${detail}`;
  }
  for (const token of quantityTokens) {
    if (!variantTokenPresentInTitle(title, token)) title = `${title} ${token}`;
  }
  title = title.trim().replace(/\s+/g, ' ');
  if (!title) return null;
  if (brand?.trim() && title.toLowerCase() === brand.trim().toLowerCase()) return null;
  return title;
}

function equivalentTitle(a: string, b: string): boolean {
  return a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    === b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function escapeRegExpLiteral(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * Measurement-only spans (a bare quantity like `5 lb`, or brand + quantity)
 * supply quantity tokens to the shared union — they never stand as
 * candidate bodies. A body with no substance beyond the brand would
 * otherwise mint degenerate candidates (`Acme 5 lb`) that turn a single
 * evidenced name into spurious ambiguity. Shipping-weight spans never
 * reach here (excluded by the caller).
 */
function isMeasurementOnlySpan(span: string, brand: string | null): boolean {
  const normalized = normalizeSpan(span);
  let rest = normalized;
  for (const token of extractProtectedTokens(normalized)) {
    rest = rest.split(token).join(' ');
  }
  if (brand?.trim()) {
    for (const word of brand.trim().split(/[^a-z0-9]+/i).filter(Boolean)) {
      rest = rest.replace(new RegExp(`\\b${escapeRegExpLiteral(word)}\\b`, 'gi'), ' ');
    }
  }
  return rest.replace(/[^a-z0-9]+/gi, '').length === 0;
}


/**
 * Build complete evidence-backed candidates from eligible per-SKU spans.
 *
 * Deterministic: same eligible input always yields the same candidate set.
 * Zero model calls. Sibling context is never an input here — presentation
 * only, enforced by the callers (cohort prompt context), never by candidate
 * construction.
 */
export interface NameCandidateOverflow {
  kind: 'overflow';
  reason: string;
  candidateCount: number;
}

export type NameCandidateResult =
  | NameCandidateOutcome
  | NameCandidateOverflow;

export function buildNameCandidates(input: {
  spans: NameEvidenceText[];
  brand: string | null;
}): NameCandidateResult {
  const eligible = input.spans.filter(s => s.span.trim().length > 0);
  if (eligible.length === 0) {
    return {
      kind: 'missing',
      reason: 'missing_evidence: no eligible register, official, distributor, OCR, or manual text for this SKU.',
    };
  }
  if (!input.brand?.trim()) {
    return {
      kind: 'missing',
      reason: 'missing_brand: no brand in eligible evidence — supply an operator manual title/brand and re-run.',
    };
  }
  // Shipping weight is evidence of the parcel, never of the product: its
  // spans contribute no tokens, no sizes, and no candidate bodies — net
  // contents alone decide the name.
  const netSpans = eligible.filter(s => !isShippingWeightSpan(s.span));
  const { netTokens } = splitNetVsShipping(netSpans);
  // Variant quantity is not universally required: model-number parts and
  // unmeasured products remain nameable. Any evidenced quantity still
  // remains part of its source-backed candidate below.
  const conflict = findSizeConflict(netTokens);
  if (conflict.length > 0) {
    return {
      kind: 'conflict',
      reason: `conflicting_sizes: eligible evidence carries distinct package quantities (${conflict.join(', ')}) — resolve the identity conflict before naming.`,
      conflictingTokens: conflict,
    };
  }
  // Union of every evidenced quantity: post-conflict-check all quantities
  // agree, so the union is the mandatory detail every candidate carries.
  const requiredQuantities = netTokens;
  const seen: NameCandidateInput[] = [];
  const push = (title: string | null, components: string[], evidenceIds: string[]): void => {
    if (!title || title.length < 2 || title.length > 500) return;
    if (seen.some(c => equivalentTitle(c.title, title))) return;
    seen.push({ title, components, evidenceIds });
  };
  const evidenceIdsOf = (spans: NameEvidenceText[]): string[] =>
    [...new Set(spans.map(s => s.evidenceId).filter((id): id is string => !!id))];
  // Attribute-only values can complete a real name but never stand alone.
  // Preserve identity descriptors on every candidate; reject conflicting
  // values instead of unioning distinct flavors, recipes, or life stages.
  const attributeSpans = netSpans.filter(s => isAttributeOnlySpan(s.span, input.brand, s.kind));
  const detailSpans = attributeSpans.filter((s) => s.kind !== undefined);
  const detailByKind = new Map<NonNullable<NameEvidenceText['kind']>, string[]>();
  const conflictingDetails: string[] = [];
  for (const span of detailSpans) {
    const kind = span.kind;
    if (!kind) continue;
    const values = detailByKind.get(kind) ?? [];
    if (kind !== 'species' && values.some((value) => value.trim().toLowerCase() !== span.span.trim().toLowerCase())) {
      conflictingDetails.push(...values, span.span);
    } else if (!values.some((value) => value.trim().toLowerCase() === span.span.trim().toLowerCase())) {
      values.push(span.span);
      detailByKind.set(kind, values);
    }
  }
  if (conflictingDetails.length > 0) {
    return { kind: 'conflict', reason: 'conflicting_identity_attributes: accepted evidence contains distinct values for a single-valued name-defining attribute.', conflictingTokens: [...new Set(conflictingDetails)] };
  }
  const requiredDetails = [...detailByKind.entries()].flatMap(([kind, values]) =>
    values.map((value) => kind === 'pack_count' && /^\d+(?:\.\d+)?$/.test(value.trim()) ? `${value.trim()} pack` : value),
  );
  const detailComponents = detailSpans.map((s) => s.span);
  const detailEvidenceIds = evidenceIdsOf(detailSpans);
  const bodySpans = netSpans.filter(s => !isAttributeOnlySpan(s.span, input.brand, s.kind));
  if (bodySpans.length === 0) {
    return {
      kind: 'missing',
      reason: 'missing_evidence: eligible spans carry no complete product identity — only measurements or attributes with no substantive product name for this SKU.',
    };
  }
  const quantityOf = (spanText: string): string[] => {
    const out: string[] = [];
    for (const token of extractProtectedTokens(spanText)) {
      const normalized = normalizeProtectedToken(token);
      if (!out.some(t => t.toLowerCase() === normalized.toLowerCase())) out.push(normalized);
    }
    return out;
  };
  // Quantity identity is dimension-aware with unit conversion (mass in
  // ounces, volume in fluid ounces): `5 lb` and `80 oz` are the same
  // evidenced detail, while cross-dimension pairs (`16 fl oz` vs `1 lb`)
  // never match. A span completed with borrowed quantities names every
  // contributing body span in its provenance — never only itself.
  const quantityKeysOf = (spanText: string): string[] =>
    quantityOf(spanText).map(sizeIdentityKey);
  const requiredKeys = requiredQuantities.map(sizeIdentityKey);
  const mergedComponents = [...bodySpans.map(s => s.span), ...attributeSpans.map(s => s.span)];
  const mergedEvidenceIds = [...new Set([...evidenceIdsOf(bodySpans), ...evidenceIdsOf(attributeSpans)])];
  for (const span of bodySpans) {
    const normalized = normalizeSpan(span.span);
    const ownTitle = assembleCandidate(normalized, input.brand, quantityOf(span.span), requiredDetails);
    const ownComplete = ownTitle !== null
      && requiredQuantities.every(q => variantTokenPresentInTitle(ownTitle, q));
    if (ownComplete) {
      push(ownTitle, [span.span, ...detailComponents], [...new Set([...(span.evidenceId ? [span.evidenceId] : []), ...detailEvidenceIds])]);
    } else {
      const ownKeys = quantityKeysOf(span.span);
      const borrowedKeys = requiredKeys.filter(k => !ownKeys.some(o => o === k));
      const contributors = netSpans.filter(s => {
        if (s === span) return false;
        return quantityKeysOf(s.span).some(k => borrowedKeys.some(b => b === k));
      });
      push(
        assembleCandidate(normalized, input.brand, requiredQuantities, requiredDetails),
        [span.span, ...contributors.map(s => s.span), ...detailComponents],
        [...new Set([...(span.evidenceId ? [span.evidenceId] : []), ...evidenceIdsOf(contributors), ...detailEvidenceIds])],
      );
    }
  }
  // Identical body spans (register + distributor echoing the same title)
  // merge to one body — joining raw duplicates would mint a doubled title
  // ("Acme Kibble 5 lb Acme Kibble 5 lb") that turns agreement into
  // spurious ambiguity no deterministic choice can resolve.
  const uniqueBodies = [...new Set(bodySpans.map((s) => normalizeSpan(s.span)))];
  const mergedBody = uniqueBodies.join(' ');
  push(
    assembleCandidate(mergedBody, input.brand, requiredQuantities, requiredDetails),
    mergedComponents,
    mergedEvidenceIds,
  );
  if (seen.length === 0) {
    return {
      kind: 'missing',
      reason: 'missing_evidence: eligible spans produced no valid complete candidate.',
    };
  }
  // Overflow is explicit and never silently clipped: more than 16 complete
  // candidates abstain visibly (callers surface the count) instead of
  // selecting from a clipped prefix.
  if (seen.length > MAX_NAME_CANDIDATES) {
    return {
      kind: 'overflow',
      reason: `candidate_overflow: ${seen.length} complete name candidates exceed the ${MAX_NAME_CANDIDATES}-candidate bound — ambiguous set abstains visibly, never clips to a prefix.`,
      candidateCount: seen.length,
    };
  }
  return { kind: 'candidates', candidates: seen, overflow: false };
}


/**
 * Deterministic choice over deduplicated candidates: a single candidate, or
 * a set whose members are all formatting-equivalent, resolves with zero
 * paid selection calls. Anything semantically ambiguous needs typed Choice.
 */
export function deterministicNameChoice(
  candidates: NameCandidateInput[],
): NameCandidateInput | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const first = candidates[0].title;
  if (candidates.every(c => equivalentTitle(c.title, first))) return candidates[0];
  return null;
}
/** Project only current, confirmed facts into source-backed name spans. */
export function acceptedItemNameSpans(evidence: AcceptedItemEvidence): { spans: NameEvidenceText[]; brand: string | null; conflictingBrands: string[] } {
  const observationById = new Map(evidence.observations.map((observation) => [observation.id, observation]));
  const channelByRole: Record<string, NameEvidenceChannel> = {
    manufacturer_official: 'official',
    distributor_record: 'distributor',
    retailer_corroboration: 'retailer',
    operator_attested: 'manual',
  };
  const nameFields = new Set(['title', 'name', 'brand', 'model', 'species', 'productform', 'flavor', 'formula', 'recipe', 'lifestage', 'size', 'capacity', 'weight', 'count', 'packcount', 'color', 'material', 'strength']);
  const kindByField: Record<string, NonNullable<NameEvidenceText['kind']>> = {
    species: 'species',
    productform: 'form',
    flavor: 'flavor',
    formula: 'formula',
    recipe: 'recipe',
    lifestage: 'lifestage',
    material: 'material',
    color: 'color',
    packcount: 'pack_count',
    strength: 'strength',
  };
  const brandFacts = evidence.facts.filter((fact) => {
    if (fact.field.toLowerCase() !== 'brand') return false;
    const observation = observationById.get(fact.observationId);
    return !!observation && observation.identity.itemId === evidence.itemId && observation.identity.sku === evidence.sku && observation.identity.inputHash === evidence.inputHash && observation.identity.outcome === 'confirmed';
  });
  const normalizedBrands = [...new Set(brandFacts.map((fact) => fact.value.trim().toLowerCase()))];
  const spans: NameEvidenceText[] = [{ channel: 'register', span: evidence.registerName, evidenceId: evidence.id }, ...evidence.facts.flatMap((fact) => {
    if (!nameFields.has(fact.field.toLowerCase())) return [];
    const observation = observationById.get(fact.observationId);
    if (!observation || observation.identity.itemId !== evidence.itemId || observation.identity.sku !== evidence.sku || observation.identity.inputHash !== evidence.inputHash || observation.identity.outcome !== 'confirmed') return [];
    const channel = channelByRole[observation.sourceRole];
    if (!channel) return [];
    const field = fact.field.toLowerCase();
    const kind = kindByField[field];
    return [{ channel, span: fact.rawValue, evidenceId: fact.id, ...(kind ? { kind } : {}) }];
  })];
  return { spans, brand: normalizedBrands.length === 1 ? brandFacts[0].value : null, conflictingBrands: normalizedBrands.length > 1 ? brandFacts.map((fact) => fact.value) : [] };
}

/** Build code-owned name candidates from one accepted immutable item snapshot. */
export function buildNameCandidatesFromAcceptedEvidence(evidence: AcceptedItemEvidence): NameCandidateResult {
  const { spans, brand, conflictingBrands } = acceptedItemNameSpans(evidence);
  if (conflictingBrands.length > 0) return { kind: 'conflict', reason: 'conflicting_brands: accepted item facts contain distinct brand values.', conflictingTokens: conflictingBrands };
  return buildNameCandidates({ spans, brand });
}
