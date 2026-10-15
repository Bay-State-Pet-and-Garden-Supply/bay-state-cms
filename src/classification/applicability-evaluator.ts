/**
 * Deterministic Attribute Applicability Evaluator (pure module).
 *
 * Explicit applicability states: `applicable`, `not_applicable`, `unknown`.
 * Conditions are evaluated ONLY against accepted/reviewed facts — never
 * pending guesses. Universal attributes proceed without a Product Type;
 * profile attributes require a reviewed Product Type.
 *
 * This module has no DB or workspace imports so it is safe for pure unit
 * tests and can be consumed by both the applicability stage and the
 * attribute proposals stage with identical semantics.
 */
import type { ProductAttributeConfig } from '../shared/schemas/classification';
import type { ReviewedFact } from './reviewed-facts';

export type ApplicabilityState = 'applicable' | 'not_applicable' | 'unknown';

export interface AttributeApplicability {
  attributeId: string;
  state: ApplicabilityState;
  reason?: string;
}

export interface ApplicabilityInput {
  attribute: ProductAttributeConfig;
  /** Attributes in the accepted type's profile, or null when no profile exists. */
  profileAttributeIds: Set<string> | null;
  /** Profile-entry applicability conditions for this attribute (v1 free-form). */
  conditions: unknown[];
  /** Reviewed (accepted) Primary Product Type id, or null. */
  acceptedTypeId: string | null;
  /** True when a product_type curation target is enabled (type gating applies). */
  typeTargetEnabled: boolean;
  /** Accepted/reviewed facts for deterministic condition evaluation. */
  reviewedFacts: ReviewedFact[];
  /**
   * P3 widened universal tier (plan B.P3.1): when true (flag
   * BAYSTATE_CMS_UNIVERSAL_TIER_WIDENING), attributes in
   * WIDENED_UNIVERSAL_ATTRIBUTE_IDS are PROPOSABLE from deterministic evidence
   * while NO Product Type exists. Profile enforcement is unchanged — once a
   * type is accepted the normal profile gating applies below and a widened
   * attribute outside the profile stays `not_applicable`. Undefined/false is
   * byte-identical legacy behavior.
   */
  widenedUniversal?: boolean;
}

/**
 * P3 widened universal tier (plan B.P3.1): high-yield merchandising attributes
 * that may be PROPOSED from deterministic evidence regardless of Product Type
 * status while BAYSTATE_CMS_UNIVERSAL_TIER_WIDENING is on. Membership here
 * widens PROPOSABILITY only — it never bypasses proposal safety validation,
 * never bypasses profile requiredness/cardinality/applicability once a type
 * is accepted, and never grants these ids `isUniversal` in config (the frozen
 * release taxonomy is untouched).
 */
export const WIDENED_UNIVERSAL_ATTRIBUTE_IDS: ReadonlySet<string> = new Set([
  'size',
  'color',
  'material',
  'flavor',
]);

/**
 * v1 runtime attributes have no `isUniversal` field (it arrives with v2).
 * Universal attributes proceed without a Product Type whenever the flag is
 * present and true; the accessor is type-safe for both config generations.
 */
export function isUniversalAttribute(attribute: ProductAttributeConfig): boolean {
  return (attribute as { isUniversal?: boolean }).isUniversal === true;
}

function normalizeCondition(condition: unknown): {
  operator: 'equals' | 'in' | 'containsAny';
  attributeId: string;
  values: string[];
} | null {
  if (!condition || typeof condition !== 'object') return null;
  const candidate = condition as Record<string, unknown>;
  const operator = candidate.operator;
  if (operator !== 'equals' && operator !== 'in' && operator !== 'containsAny') return null;
  if (typeof candidate.attributeId !== 'string' || candidate.attributeId.length === 0) return null;
  const values =
    operator === 'equals'
      ? [typeof candidate.value === 'string' ? candidate.value : String(candidate.value ?? '')]
      : Array.isArray(candidate.values)
        ? candidate.values.map(String)
        : [];
  if (values.length === 0 || values.some(v => v.length === 0)) return null;
  return { operator, attributeId: candidate.attributeId, values };
}

/**
 * Evaluate profile applicability conditions against accepted/reviewed facts.
 * Any missing fact or unrecognized condition shape evaluates to `unknown`.
 */
export function evaluateConditions(conditions: unknown[], facts: ReviewedFact[]): ApplicabilityState {
  if (!conditions || conditions.length === 0) return 'applicable';

  for (const raw of conditions) {
    const condition = normalizeCondition(raw);
    if (!condition) return 'unknown';

    const fact = facts.find(
      candidate => candidate.targetId === condition.attributeId,
    );
    if (!fact) {
      // The condition depends on a fact that has not been accepted/reviewed.
      return 'unknown';
    }

    if (condition.operator === 'equals') {
      const factValue = Array.isArray(fact.value) ? fact.value[0] : fact.value;
      if (String(factValue ?? '') === condition.values[0]) continue;
      return 'not_applicable';
    }

    if (condition.operator === 'in') {
      const factValue = Array.isArray(fact.value) ? fact.value[0] : fact.value;
      if (condition.values.includes(String(factValue ?? ''))) continue;
      return 'not_applicable';
    }

    // containsAny: the fact value (or its array members) intersects the values.
    const factValues = Array.isArray(fact.value)
      ? fact.value.map(String)
      : [String(fact.value ?? '')];
    const hits = condition.values.filter(value => factValues.includes(value));
    if (hits.length > 0) continue;
    return 'not_applicable';
  }

  return 'applicable';
}

/**
 * Deterministically evaluate one attribute's applicability. Pure over the
 * supplied inputs — shared by the applicability stage and the attribute
 * proposals stage so both enforce identical gating.
 */
export function evaluateAttributeApplicability(
  input: ApplicabilityInput,
): AttributeApplicability {
  const { attribute } = input;

  if (!input.typeTargetEnabled) {
    return {
      attributeId: attribute.id,
      state: 'applicable',
      reason: 'No Product Type target enabled; attribute is not type-gated.',
    };
  }
  if (isUniversalAttribute(attribute)) {
    return {
      attributeId: attribute.id,
      state: 'applicable',
      reason: 'Universal attribute requires no Product Type.',
    };
  }
  // P3 widened universal tier: pre-type proposals only. When a type IS
  // accepted this branch never fires — the profile gating below still governs
  // requiredness/cardinality/applicability exactly as before.
  if (
    input.widenedUniversal === true
    && input.typeTargetEnabled
    && input.acceptedTypeId === null
    && WIDENED_UNIVERSAL_ATTRIBUTE_IDS.has(attribute.id)
  ) {
    return {
      attributeId: attribute.id,
      state: 'applicable',
      reason:
        'Widened universal tier proposes from evidence without a Product Type; '
        + 'the Attribute Profile still enforces requiredness/applicability once a type is accepted.',
    };
  }
  if (input.acceptedTypeId === null) {
    return {
      attributeId: attribute.id,
      state: 'unknown',
      reason: 'No Product Classification (reviewed or provisional); type-gated attribute is blocked until the pair is proposed.',
    };
  }
  if (input.profileAttributeIds !== null && !input.profileAttributeIds.has(attribute.id)) {
    return {
      attributeId: attribute.id,
      state: 'not_applicable',
      reason: `Attribute is not in the accepted Product Type profile (${input.acceptedTypeId}).`,
    };
  }

  const state = evaluateConditions(input.conditions, input.reviewedFacts);
  const reason =
    state === 'unknown'
      ? 'Applicability condition cannot be decided from accepted/reviewed facts.'
      : state === 'not_applicable'
        ? 'Applicability condition is not satisfied by accepted/reviewed facts.'
        : undefined;
  return { attributeId: attribute.id, state, reason };
}
