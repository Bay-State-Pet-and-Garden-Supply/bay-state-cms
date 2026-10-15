/**
 * P1 #9, #11, #12, #14, #16 — shared attribute-evidence grounding guards.
 *
 * One home for the deterministic gates every attribute path (deterministic
 * alias match, detail enrichment, SystemOne/LLM fallback, invariant
 * proposals) must pass:
 *
 * - #16: placeholder-fragment drop ("I" and friends never justify a value);
 *   every ordinary proposed attribute needs at least one supporting
 *   value-bearing citation; context/contradictions stay separate; the actual
 *   quote/source is exposed for review.
 * - #11: species grounding — target-animal labeling, confirmed type scope,
 *   or a known species-specific item counts. Material ("cowhide"), color
 *   names ("Chicken Yellow"), and ingredient/flavor words never assign
 *   target species. "For Fish" is target species, not flavor Fish.
 *   Conflicting dog/cat labels abstain.
 * - #12: visual detail grounding — High Viz/Ladybug/Colored/Colorful are not
 *   colors; a fuzzy "string" toy name/texture is not material; a "jar" sold
 *   item is not Jar packaging; "blister" is not Pouch. Title beats a
 *   contradicting OCR read; confirmed Blue/Nylon/Bottle quotes support their
 *   fields only after image confirmation. No size heuristic lives here —
 *   PF19/PF27 retire via TaxonomyV10 (#10).
 * - #14: life-stage mapping — explicit "DOGS & PUPPIES"/"ADULT & PUPPY"
 *   coverage maps to All Life Stages with a supporting citation; ambiguous
 *   partial age terms abstain rather than selecting top-1.
 * - #9: no-narrowing — a populated multi-value slot (existing pipes) is
 *   never silently replaced by a partial single value; intentional reduction
 *   needs a separate explicit edit. Empty slots still accept grounded values.
 *
 * Release-agnostic pure functions. Fixture dependency note: golden fixtures
 * are release-agnostic unit fixtures (synthetic targets + v9 ids where
 * release-independent); "passes on v10" is satisfied by these plus the
 * TaxonomyV10-owned v10 validation test.
 */
import type { ClassificationEvidence } from '../shared/types';

/** Placeholder OCR/text fragments that never justify an attribute value. */
const PLACEHOLDER_FRAGMENTS = ['i', 'a', 'the', 'and', '-', '—', '•', '...'];

export function isPlaceholderFragment(text: string): boolean {
  const norm = text.normalize('NFC').trim().toLocaleLowerCase();
  return norm.length === 0 || PLACEHOLDER_FRAGMENTS.includes(norm);
}

/** True when the record carries a value-bearing (non-placeholder) assertion. */
export function isValueBearingRecord(record: ClassificationEvidence): boolean {
  const raw = typeof record.value === 'string'
    ? record.value
    : typeof record.snippet === 'string'
      ? record.snippet
      : '';
  const norm = raw.normalize('NFC').trim();
  if (norm.length < 2) return false;
  return !isPlaceholderFragment(norm);
}

export type GroundingVerdict =
  | { grounded: true; supportingId: string; quote: string }
  | { grounded: false; reason: string };

function recordQuote(record: ClassificationEvidence): string {
  const raw = typeof record.value === 'string' && record.value.trim()
    ? record.value
    : (record.snippet ?? '');
  return raw.slice(0, 300);
}

/** General title/description text records (name/title/description only). */
function isTitleDescriptionRecord(record: ClassificationEvidence): boolean {
  return record.sourceField === 'name'
    || record.sourceField === 'title'
    || record.sourceField === 'description';
}

/**
 * #16: require at least one supporting value-bearing citation for an
 * ordinary proposed attribute. Returns the first supporting record's quote
 * for review display.
 */
export function requireSupportingCitation(
  supporting: ClassificationEvidence[],
): GroundingVerdict {
  for (const record of supporting) {
    if (!isValueBearingRecord(record)) continue;
    return { grounded: true, supportingId: record.id, quote: recordQuote(record) };
  }
  return { grounded: false, reason: 'no supporting value-bearing citation (placeholder or empty evidence cannot justify a value)' };
}

// ─── #11 species grounding ───────────────────────────────────────────────

/** Material words that never assign target species. */
const SPECIES_MATERIAL_WORDS = ['cowhide', 'leather', 'suede', 'canvas', 'nylon'];

/** Color-name words that never assign target species ("Chicken Yellow"). */
const SPECIES_COLOR_WORDS = ['chicken yellow', 'chicken-yellow'];

/** Flavor/ingredient words that never assign target species. */
const SPECIES_FLAVOR_WORDS = [
  'chicken', 'beef', 'salmon', 'tuna', 'turkey', 'duck', 'lamb', 'venison',
  'fish', 'shrimp', 'pork', 'liver', 'whitefish', 'bison', 'rabbit',
];

/** Known species-specific items that DO ground species. */
const SPECIES_SPECIFIC_ITEMS = [
  'catnip', 'litter box', 'scratching post', 'cat tree', 'bird feeder',
  'aquarium', 'terrarium', 'saddle', 'horseshoe', 'dog crate', 'kennel',
];

export interface SpeciesGrounding {
  species: string | null;
  abstain: boolean;
  reason: string | null;
}

/**
 * Ground a species proposal from title/description evidence roles.
 * `titleText` is the lowercased title+description text; `typeScope` is the
 * confirmed type's animal domain (or null); `reviewedTypeSpecies` is the
 * invariant species of the accepted type (or null).
 */
export function groundSpeciesProposal(input: {
  proposedSpecies: string;
  titleText: string;
  typeScope?: string | null;
  reviewedTypeSpecies?: string | null;
}): SpeciesGrounding {
  const { proposedSpecies, titleText, typeScope, reviewedTypeSpecies } = input;
  const text = titleText.toLocaleLowerCase();
  const proposed = proposedSpecies.toLocaleLowerCase();
  // Conflicting dog/cat labels abstain.
  const mentionsDog = /\b(dog|dogs|canine|puppy|puppies)\b/.test(text);
  const mentionsCat = /\b(cat|cats|feline|kitten|kittens)\b/.test(text);
  if (mentionsDog && mentionsCat) {
    return { species: null, abstain: true, reason: 'conflicting dog/cat target-animal labels abstain' };
  }
  // "For <animal>" target labeling counts (For Fish = species, not flavor).
  const forMatch = text.match(/\bfor\s+(dogs|cats|fish|birds|wild birds|wild-bird|cattle|horses|poultry)\b/);
  if (forMatch) {
    const target = forMatch[1].replace(/^dogs$/, 'dog').replace(/^cats$/, 'cat');
    if (target === proposed || proposed.includes(target) || target.includes(proposed)) {
      return { species: proposedSpecies, abstain: false, reason: null };
    }
    return { species: null, abstain: true, reason: `"for ${forMatch[1]}" targets a different species` };
  }
  // Confirmed type scope or known species-specific item grounds directly.
  if (typeScope && (typeScope.toLocaleLowerCase() === proposed || proposed.includes(typeScope.toLocaleLowerCase()))) {
    return { species: proposedSpecies, abstain: false, reason: null };
  }
  if (reviewedTypeSpecies && reviewedTypeSpecies.toLocaleLowerCase() === proposed) {
    return { species: proposedSpecies, abstain: false, reason: null };
  }
  if (SPECIES_SPECIFIC_ITEMS.some(item => text.includes(item))) {
    return { species: proposedSpecies, abstain: false, reason: null };
  }
  // Explicit "for cats"-style label on matching food permits Cat.
  if (/\bfor\s+cats\b/.test(text) && proposed === 'cat') {
    return { species: proposedSpecies, abstain: false, reason: null };
  }
  // Material / color-name / flavor-only evidence never grounds species.
  const hasOnlyNonSpeciesCues =
    SPECIES_MATERIAL_WORDS.some(w => text.includes(w))
    || SPECIES_COLOR_WORDS.some(w => text.includes(w))
    || (SPECIES_FLAVOR_WORDS.some(w => text.includes(w))
      && !new RegExp(`\\b${proposed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
  if (hasOnlyNonSpeciesCues) {
    return { species: null, abstain: true, reason: 'ingredient/flavor/material/color evidence never assigns target species' };
  }
  // Bare ingredient word matching the species name (e.g. "fish" as flavor)
  // is not target-species evidence unless a target cue exists.
  if (!new RegExp(`\\b${proposed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)) {
    return { species: null, abstain: true, reason: 'no target-animal labeling for the proposed species' };
  }
  return { species: proposedSpecies, abstain: false, reason: null };
}

// ─── #12 visual detail grounding ─────────────────────────────────────────

const COLOR_NON_COLORS = ['high viz', 'high-viz', 'ladybug', 'colored', 'colorful', 'assorted colors'];
const PACKAGING_ITEM_NOT_PACKAGE = ['jar feeder', 'jar as the sold item'];
const BLISTER_NOT_POUCH = ['blister', 'blister card'];

export interface DetailGroundingInput {
  attributeId: string;
  proposedValue: string;
  titleText: string;
  ocrQuote: string | null;
  titleContradictsOcr: boolean;
  imageConfirmed: boolean;
}

/**
 * Ground color/material/packaging proposals. Title contradiction beats OCR;
 * unconfirmed OCR never grounds alone; confirmed exact quotes support.
 */
export function groundVisualDetail(input: DetailGroundingInput): GroundingVerdict {
  const attr = input.attributeId.toLocaleLowerCase();
  const value = input.proposedValue.toLocaleLowerCase();
  const title = input.titleText.toLocaleLowerCase();
  if (attr === 'color' && COLOR_NON_COLORS.some(w => title.includes(w) || value.includes(w))) {
    if (!input.ocrQuote) {
      return { grounded: false, reason: `"${input.proposedValue}" is a pattern/name, not a color, without a confirmed package quote` };
    }
  }
  if (attr === 'material' && /\bstring\b/.test(title) && /\btoy\b/.test(title) && !input.ocrQuote) {
    return { grounded: false, reason: 'fuzzy "string" toy name/texture is not a material without a confirmed quote' };
  }
  if (attr.includes('packag') && PACKAGING_ITEM_NOT_PACKAGE.some(w => title.includes(w))) {
    return { grounded: false, reason: '"jar" sold item is not Jar packaging' };
  }
  if (attr.includes('packag') && value.includes('pouch') && BLISTER_NOT_POUCH.some(w => title.includes(w))) {
    return { grounded: false, reason: '"blister" is not Pouch packaging' };
  }
  if (input.titleContradictsOcr) {
    return { grounded: false, reason: 'title contradicts the OCR read — title wins, OCR value withheld' };
  }
  if (input.ocrQuote && input.imageConfirmed) {
    return { grounded: true, supportingId: 'ocr-confirmed', quote: input.ocrQuote };
  }
  // Title/description-only exact value-bearing citations ground independently.
  const needle = value.normalize('NFC').toLocaleLowerCase();
  if (needle.length > 0 && title.split(/[^a-z0-9&'’.]+/).includes(needle)) {
    return { grounded: true, supportingId: 'title', quote: input.titleText.slice(0, 300) };
  }
  return { grounded: false, reason: 'no confirmed package quotation and no value-bearing title citation' };
}

// ─── #14 life-stage mapping ──────────────────────────────────────────────

export type LifeStageMapping =
  | { mapped: true; value: string; supportingQuote: string }
  | { mapped: false; abstain: true; reason: string };

/**
 * Map explicit multi-stage coverage to All Life Stages; puppy-only maps to
 * Puppy; ambiguous partial age terms abstain rather than selecting top-1.
 */
export function mapLifeStageCoverage(titleText: string): LifeStageMapping {
  const text = titleText.toLocaleLowerCase();
  const hasAdult = /\badult\b/.test(text);
  const hasPuppy = /\bpuppy\b|\bpuppies\b|\bdogs\s*&\s*puppies\b/.test(text);
  const hasKitten = /\bkitten\b|\bkittens\b/.test(text);
  if (/\bdogs\s*&\s*puppies\b/.test(text) || (hasAdult && hasPuppy)) {
    return { mapped: true, value: 'All Life Stages', supportingQuote: titleText.slice(0, 300) };
  }
  if (/\badult\s*&\s*puppy\b|\badult\s+and\s+puppy\b/.test(text)) {
    return { mapped: true, value: 'All Life Stages', supportingQuote: titleText.slice(0, 300) };
  }
  if (hasPuppy && !hasAdult && !hasKitten) {
    return { mapped: true, value: 'Puppy', supportingQuote: titleText.slice(0, 300) };
  }
  if (/\bjunior\b|\bgrowth\b|\bmaintenance\b/.test(text) && !hasAdult && !hasPuppy && !hasKitten) {
    return { mapped: false, abstain: true, reason: 'ambiguous partial age term abstains rather than selecting top-1' };
  }
  return { mapped: false, abstain: true, reason: 'no unambiguous life-stage coverage — abstain' };
}

// ─── #9 no-narrowing ─────────────────────────────────────────────────────

/**
 * True when applying `proposedSerial` over `currentSerial` would silently
 * narrow an already-populated multi-value slot. Pipe-delimited current
 * values are split on `|`; an intentional reduction needs a separate
 * explicit catalog edit (out of scope for classification apply).
 */
export function isSilentNarrowing(currentSerial: string | null, proposedSerial: string): boolean {
  if (!currentSerial || currentSerial.trim().length === 0) return false;
  const norm = (s: string): string[] =>
    s.split('|').map(part => part.normalize('NFC').trim().toLocaleLowerCase()).filter(Boolean);
  const current = norm(currentSerial);
  const proposed = norm(proposedSerial);
  if (current.length <= 1) return false;
  if (proposed.length >= current.length) return false;
  const currentSet = new Set(current);
  return proposed.every(p => currentSet.has(p));
}
