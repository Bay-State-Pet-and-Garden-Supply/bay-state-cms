/**
 * Target-specific evidence selection, canonical assertion extraction, and
 * contradiction detection (issue #17 work item H).
 *
 * Proposals no longer link every run-wide evidence record. Instead each
 * proposal carries an `EvidenceTargetPacket`: bounded `supporting`,
 * `contradicting`, and `context` records plus the separately bounded prompt
 * text. Selection uses an explicit `attributeId` first and a reviewed
 * `sourceField` mapping second — target membership is never inferred from a
 * human label. General title/description evidence may be bounded context, but
 * is supporting only when a deterministic grounding rule links it to the
 * selected canonical value.
 *
 * Single-cardinality comparable targets detect assertion conflicts: distinct
 * independently asserted canonical values produce a visible, unresolved
 * conflict that forces individual review (never silently resolved by source
 * order or model confidence). Alias-equivalent values and formatting
 * differences reconcile to the same canonical value. Multi-cardinality value
 * differences are NOT contradictions unless an explicit exclusivity rule says
 * so (none is configurable in this work item, so none is applied).
 */
import type { ClassificationEvidence } from '../shared/types';

export type EvidenceRelation = 'supporting' | 'contradicting' | 'context';

export interface AssertionConflict {
  /** Target attribute id when the conflict is attribute-scoped, else null. */
  attributeId: string | null;
  /** Reviewed source-field mapping when known, else null. */
  sourceField: string | null;
  /** Distinct canonical asserted values (≥2). */
  values: string[];
  /** Evidence ids asserting each of those values (visibility, same order as values). */
  evidenceIds: string[][];
}

export interface EvidenceTargetPacket {
  supporting: ClassificationEvidence[];
  contradicting: ClassificationEvidence[];
  context: ClassificationEvidence[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  /** Backward-compatible union (supporting + contradicting + context). */
  evidenceIds: string[];
  /** Separately bounded prompt text (supporting, then contradicting, then context). */
  promptText: string;
  /** Unresolved assertion conflicts; non-empty forces individual review. */
  conflicts: AssertionConflict[];
  hasConflict: boolean;
}

export interface ValueAlias {
  alias: string;
  mapsTo: string;
}

/**
 * General title/description evidence source fields. These are the ONLY
 * non-target records that may enter a target packet (as bounded context, or
 * as supporting only through a deterministic grounding rule). All other
 * non-target records (color/weight/etc.) are excluded entirely — never
 * context, never citable (issue #17 pass 5b).
 */
const GENERAL_TEXT_SOURCE_FIELDS = new Set(['name', 'title', 'description']);

export const ATTRIBUTE_ID_CANONICAL_MAP: Record<string, string> = {
  lifeStage: 'life-stage',
  'life-stage': 'life-stage',
  breedSize: 'breed-size',
  'breed-size': 'breed-size',
  productForm: 'food-form',
  'food-form': 'food-form',
  healthConcern: 'health-benefits',
  'health-benefits': 'health-benefits',
  dietaryLabel: 'dietary-features',
  'dietary-features': 'dietary-features',
  packagingType: 'packaging-type',
  'packaging-type': 'packaging-type',
  npkRatio: 'npk-ratio',
  'npk-ratio': 'npk-ratio',
  nutrition: 'nutrition',
  ingredients: 'nutrition',
};

export function normalizeAttributeId(id: string | null | undefined): string | null {
  if (!id) return null;
  return ATTRIBUTE_ID_CANONICAL_MAP[id] ?? id;
}

export const PRODUCT_TYPE_CONTEXT_SOURCE_FIELDS = new Set([
  'name', 'title', 'description', 'species', 'productForm', 'food-form', 'flavor', 'lifeStage', 'breedSize', 'visible_text'
]);

/** True when an evidence record is general title/description text or product type context. */
export function isPacketTextEvidence(evidence: ClassificationEvidence, includeProductTypeContext = false): boolean {
  const sf = evidence.sourceField;
  if (sf && GENERAL_TEXT_SOURCE_FIELDS.has(sf)) return true;
  if (includeProductTypeContext) {
    if (sf && PRODUCT_TYPE_CONTEXT_SOURCE_FIELDS.has(sf)) return true;
    if (evidence.attributeId && (
      evidence.attributeId === 'species' ||
      evidence.attributeId === 'food-form' ||
      evidence.attributeId === 'flavor' ||
      evidence.attributeId === 'life-stage' ||
      evidence.attributeId === 'breed-size'
    )) return true;
  }
  return false;
}

/** True when an evidence record is general title/description text. */
function isGeneralTextEvidence(evidence: ClassificationEvidence): boolean {
  return evidence.sourceField !== null && evidence.sourceField !== undefined
    && GENERAL_TEXT_SOURCE_FIELDS.has(evidence.sourceField);
}

export interface EvidenceTargetPacketOptions {
  /** Explicit attribute id (first-priority target selection). */
  attributeId?: string | null;
  /** Reviewed source-field mapping (second-priority selection). */
  sourceField?: string | null;
  /**
   * Additional reviewed source-field mappings (OR-ed with `sourceField`).
   * Used where a target's evidence is emitted under multiple reviewed field
   * names (e.g. the brand target's `brand`/`resolved_brand` source fields
   * alongside its catalog field). Explicit attributeId still wins; a record
   * with a disagreeing explicit attributeId is still denied.
   */
  sourceFields?: string[] | null;
  /** Single-cardinality comparable targets detect assertion conflicts. */
  selectionMode?: 'single' | 'multiple';
  /** The selected/proposed canonical value for grounding (optional). */
  proposedValue?: unknown;
  /** Attribute value aliases for reconciliation (alias → exact id/value). */
  aliases?: ValueAlias[];
  /** Prompt text cap (default 3_000 characters). */
  promptTextCap?: number;
  /** Per-value snippet cap (default 500 characters). */
  valueCap?: number;
  /**
   * When true, includes visual OCR context (species, productForm, food-form, visible_text)
   * in the packet. Used for Product Type matching.
   */
  includeProductTypeContext?: boolean;
  /**
   * Deterministic grounding rule: when provided, a non-target-matching
   * evidence record may count as SUPPORTING only if its canonical assertion
   * equals the selected value through this rule (used for general
   * title/description evidence). Default: no such rule — non-matching
   * evidence is context only.
   */
  isGroundingSupport?: (evidence: ClassificationEvidence, proposedValue: unknown) => boolean;
}

/** NFC normalize + trim a scalar to its canonical assertion string. */
export function canonicalAssertionValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = value.normalize('NFC').trim();
    return normalized.length > 0 ? normalized : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

/** Resolve a raw assertion through value aliases to its canonical value. */
export function resolveCanonicalAssertion(
  raw: unknown,
  aliases: ValueAlias[] = [],
): string | null {
  const canonical = canonicalAssertionValue(raw);
  if (canonical === null) return null;
  for (const alias of aliases) {
    if (alias.mapsTo && canonicalAssertionValue(alias.alias) === canonical) {
      return canonicalAssertionValue(alias.mapsTo);
    }
  }
  return canonical;
}

/**
 * Deterministic target membership: explicit attributeId first, reviewed
 * source-field mapping second. Never infer membership from a human label.
 *
 * Fail closed on explicit attributeId disagreement: a record explicitly
 * tagged with a DIFFERENT attribute id (e.g. attributeId=color for a flavor
 * target) is denied even if its sourceField matches the target's mapping.
 * A record with no attributeId falls back to the reviewed source-field
 * mapping.
 */
export function evidenceMatchesTarget(
  evidence: ClassificationEvidence,
  options: Pick<EvidenceTargetPacketOptions, 'attributeId' | 'sourceField' | 'sourceFields'>,
): boolean {
  const attributeId = options.attributeId ?? null;
  const sourceFields = [
    ...(options.sourceField ? [options.sourceField] : []),
    ...(options.sourceFields ?? []),
  ];
  if (attributeId && evidence.attributeId === attributeId) return true;
  const normTarget = normalizeAttributeId(attributeId);
  const normEvidence = normalizeAttributeId(evidence.attributeId);
  if (normTarget && normEvidence && normTarget === normEvidence) return true;
  if (evidence.attributeId) {
    // An explicit attributeId that disagrees with the target denies the
    // record — the source-field mapping never overrides an explicit
    // attribute identity.
    return false;
  }
  if (sourceFields.length > 0 && evidence.sourceField !== null && evidence.sourceField !== undefined
    && sourceFields.includes(evidence.sourceField)) {
    return true;
  }
  return false;
}

/** Extract a comparable canonical assertion from an evidence record. */
function evidenceAssertion(
  evidence: ClassificationEvidence,
  aliases: ValueAlias[] = [],
): string | null {
  // Prefer the structured value; fall back to the snippet for text evidence.
  if (evidence.value !== null && evidence.value !== undefined) {
    if (Array.isArray(evidence.value)) {
      // A multi-value assertion: not comparable as a single canonical value.
      return null;
    }
    const resolved = resolveCanonicalAssertion(evidence.value, aliases);
    if (resolved !== null) return resolved;
  }
  return resolveCanonicalAssertion(evidence.snippet, aliases);
}

function boundedValue(evidence: ClassificationEvidence, valueCap: number): string {
  const raw = typeof evidence.value === 'string'
    ? evidence.value
    : evidence.value !== null && evidence.value !== undefined
      ? JSON.stringify(evidence.value)
      : (evidence.snippet ?? '');
  return raw.slice(0, valueCap);
}

/**
 * Build the bounded target-specific evidence packet for one proposal.
 *
 * - Target-matching evidence with a canonical assertion equal to the proposed
 *   value (through aliases) is SUPPORTING.
 * - Target-matching evidence with a DIFFERENT canonical assertion is
 *   CONTRADICTING (single-cardinality comparable targets only).
 * - Non-matching evidence is CONTEXT, except when a deterministic grounding
 *   rule links it to the selected value (then SUPPORTING).
 * - Distinct asserted canonical values among target-matching evidence
 *   (single-cardinality) produce a visible conflict.
 */
export function buildEvidenceTargetPacket(
  evidence: ClassificationEvidence[],
  options: EvidenceTargetPacketOptions = {},
): EvidenceTargetPacket {
  const {
    attributeId = null,
    sourceField = null,
    sourceFields = null,
    selectionMode = 'single',
    proposedValue,
    aliases = [],
    promptTextCap = 3_000,
    valueCap = 500,
    isGroundingSupport,
  } = options;

  const selectedCanonical = resolveCanonicalAssertion(proposedValue, aliases);
  const isSingleComparable = selectionMode === 'single'
    && selectedCanonical !== null
    && !Array.isArray(proposedValue);

  const supporting: ClassificationEvidence[] = [];
  const contradicting: ClassificationEvidence[] = [];
  const context: ClassificationEvidence[] = [];

  // Distinct canonical assertions among target-matching evidence, keyed by the
  // asserting evidence ids — used for conflict detection and to never resolve
  // disagreements by source order.
  const assertionByValue = new Map<string, string[]>();
  const targetMatching: ClassificationEvidence[] = [];

  for (const record of evidence) {
    if (evidenceMatchesTarget(record, { attributeId, sourceField, sourceFields })) {
      targetMatching.push(record);
    }
  }

  // First pass over target-matching evidence: gather canonical assertions.
  for (const record of targetMatching) {
    const assertion = evidenceAssertion(record, aliases);
    if (assertion === null) continue;
    const existing = assertionByValue.get(assertion) ?? [];
    existing.push(record.id);
    assertionByValue.set(assertion, existing);
  }

  // Unresolved conflict: two or more distinct asserted canonical values.
  // values and evidenceIds stay ALIGNED (pairs sorted together so an id is
  // never displayed against the wrong canonical value).
  const conflicts: AssertionConflict[] = [];
  if (isSingleComparable && assertionByValue.size >= 2) {
    const pairs = [...assertionByValue.entries()].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
    );
    conflicts.push({
      attributeId,
      sourceField,
      values: pairs.map(pair => pair[0]),
      evidenceIds: pairs.map(pair => pair[1]),
    });
  }

  // Second pass: classify each record into supporting/contradicting/context.
  for (const record of evidence) {
    const matchesTarget = evidenceMatchesTarget(record, { attributeId, sourceField, sourceFields });
    if (matchesTarget) {
      const assertion = evidenceAssertion(record, aliases);
      if (isSingleComparable && assertion !== null) {
        if (assertion === selectedCanonical) {
          supporting.push(record);
        } else {
          contradicting.push(record);
        }
      } else if (isSingleComparable && assertion === null) {
        // Target-matching but not comparable (e.g. non-scalar value): context.
        context.push(record);
      } else {
        // Multiple cardinality: differing values are NOT contradictions.
        const asserted = evidenceAssertion(record, aliases);
        if (asserted !== null && Array.isArray(proposedValue)) {
          const proposedSet = new Set(
            proposedValue
              .map(v => resolveCanonicalAssertion(v, aliases))
              .filter((v): v is string => v !== null),
          );
          if (proposedSet.has(asserted)) {
            supporting.push(record);
          } else {
            context.push(record);
          }
          continue;
        }
        context.push(record);
      }
      continue;
    }
    // Non-target records: ONLY general title/description evidence may enter
    // the packet. When a deterministic grounding rule links it to the
    // selected canonical value it is SUPPORTING; otherwise it is bounded
    // context. Every other non-target record (color/weight/custom fields) is
    // excluded entirely — never context, never citable.
    if (!isPacketTextEvidence(record, options.includeProductTypeContext)) {
      continue;
    }
    if (
      isSingleComparable
      && selectedCanonical !== null
      && isGroundingSupport
      && isGroundingSupport(record, proposedValue)
    ) {
      supporting.push(record);
    } else {
      context.push(record);
    }
  }

  const supportingEvidenceIds = supporting.map(r => r.id).filter(Boolean);
  const contradictingEvidenceIds = contradicting.map(r => r.id).filter(Boolean);
  const contextIds = context.map(r => r.id).filter(Boolean);

  // Separately bounded prompt text: supporting, then contradicting, then
  // context, with per-value caps and an overall cap.
  const parts: string[] = [];
  for (const group of [supporting, contradicting, context]) {
    for (const record of group) {
      parts.push(boundedValue(record, valueCap));
    }
  }
  let promptText = parts.join(' ').trim();
  if (promptText.length > promptTextCap) {
    promptText = promptText.slice(0, promptTextCap);
  }

  return {
    supporting,
    contradicting,
    context,
    supportingEvidenceIds,
    contradictingEvidenceIds,
    evidenceIds: [...supportingEvidenceIds, ...contradictingEvidenceIds, ...contextIds],
    promptText,
    conflicts,
    hasConflict: conflicts.length > 0,
  };
}

/**
 * Aggregate a target packet for the page stage: only target-relevant
 * identity/species/type/category context is used; cross-species evidence
 * remains a contradiction/rejection signal, never hidden concatenated text.
 */
export function buildPageEvidencePacket(
  evidence: ClassificationEvidence[],
  options: Pick<EvidenceTargetPacketOptions, 'sourceField' | 'aliases' | 'promptTextCap' | 'valueCap'> & {
    /** Reviewed page-context source fields (identity/species/type/category). */
    pageContextSourceFields: string[];
    /**
     * Reviewed page-context attribute ids (e.g. ['species']) — records with an
     * explicit attributeId are included even when they lack the source field.
     */
    pageContextAttributeIds?: string[];
    /** The product's reviewed species value for cross-species detection. */
    speciesValue?: unknown;
  },
): EvidenceTargetPacket {
  const pageAttributeIds = new Set(options.pageContextAttributeIds ?? []);
  const pageEvidence = evidence.filter(record => {
    if (record.attributeId && pageAttributeIds.has(record.attributeId)) return true;
    return options.pageContextSourceFields.includes(record.sourceField ?? '');
  });
  // Cross-species evidence is a contradiction/rejection signal when the
  // asserted species differs from the reviewed product species. Assertions
  // use exact canonical/alias identity — never case folding.
  const contradicting: ClassificationEvidence[] = [];
  const context: ClassificationEvidence[] = [];
  for (const record of pageEvidence) {
    const isSpeciesRecord =
      record.attributeId === 'species' || record.sourceField === 'species';
    if (
      isSpeciesRecord
      && options.speciesValue !== undefined
      && record.value !== null
      && record.value !== undefined
    ) {
      const asserted = resolveCanonicalAssertion(record.value, options.aliases);
      const reviewed = resolveCanonicalAssertion(options.speciesValue, options.aliases);
      if (asserted !== null && reviewed !== null && asserted !== reviewed) {
        contradicting.push(record);
        continue;
      }
    }
    context.push(record);
  }
  const supportingEvidenceIds: string[] = [];
  const contradictingEvidenceIds = contradicting.map(r => r.id).filter(Boolean);
  const contextIds = context.map(r => r.id).filter(Boolean);
  const valueCap = options.valueCap ?? 500;
  const parts = [...contradicting, ...context].map(record => boundedValue(record, valueCap));
  let promptText = parts.join(' ').trim();
  const promptTextCap = options.promptTextCap ?? 3_000;
  if (promptText.length > promptTextCap) promptText = promptText.slice(0, promptTextCap);

  return {
    supporting: [],
    contradicting,
    context,
    supportingEvidenceIds,
    contradictingEvidenceIds,
    evidenceIds: [...supportingEvidenceIds, ...contradictingEvidenceIds, ...contextIds],
    promptText,
    conflicts: [],
    hasConflict: contradicting.length > 0,
  };
}

/**
 * Deterministic grounding rule for general title/description evidence: a
 * title/description record supports a selected canonical value when the value
 * appears as a whole token in the record's text (case- and diacritic-folded).
 *
 * Fail closed: only general title/description evidence can be grounded — a
 * color/weight/other record is never grounded into supporting a different
 * target's value.
 */
export function tokenGroundingSupport(
  evidence: ClassificationEvidence,
  proposedValue: unknown,
): boolean {
  if (!isGeneralTextEvidence(evidence)) return false;
  const target = canonicalAssertionValue(proposedValue);
  if (target === null) return false;
  const haystack = [
    typeof evidence.value === 'string' ? evidence.value : '',
    evidence.snippet ?? '',
  ]
    .join(' ')
    .normalize('NFC')
    .toLocaleLowerCase();
  const needle = target.normalize('NFC').toLocaleLowerCase();
  if (needle.length === 0) return false;
  return haystack.split(/[^a-z0-9&'’.]+/).includes(needle);
}
