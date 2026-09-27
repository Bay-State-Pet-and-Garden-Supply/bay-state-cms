/**
 * Canonical Single-Value Controlled Attribute Decision Boundary (Issue #298 / ADR 0033).
 *
 * Single internal canonical-decision boundary for Controlled Product Attributes,
 * supporting single-value controlled choices via TypeSafe Jev System One.
 *
 * Enforces:
 * - Deterministic matching, reviewed facts, brand shortcuts, and invariants retain precedence.
 * - Free-text and measured-value paths do not enter the Jev controlled-choice adapter.
 * - Explicit multi-value handling: cardinality === 'multiple' produces explicit abstention
 *   (multi_value_unsupported), never silent single-choice conversion.
 * - TypeSafe Jev System One Choice dispatch when provider is configured for System One.
 * - Choice criteria over complete eligible frozen controlled options plus explicit
 *   `no_match` and `insufficient_evidence` outcomes.
 * - Request-local option keys map directly to canonical IDs/values.
 * - Maximum 253 ordinary candidates; >253 produces explicit limit abstention (no clipping).
 * - Target-specific permitted evidence; visual evidence excluded when visualEvidenceEligibility === 'ineligible'.
 * - Batching independent questions ONLY when their permitted state is identical; never union
 *   restricted evidence across attributes for efficiency.
 * - Claims and composition safeguards: direct-evidence provenance required; high probability cannot
 *   authorize an unsupported claim or infer a negative claim from absence.
 * - Stored selected probability and vendor concentration confidence separated with explicit basis.
 * - Development-fitted threshold (0.50 floor); no clamps or probability boosting.
 * - Protected execution with audit rows in `classification_model_calls` and lease assertions.
 * - Fallback to existing chat LLM ranker when provider is openai-compatible/ollama-native.
 */

import { randomUUID } from 'node:crypto';
import {
  dispatchSystemOne,
  SYSTEMONE_MAX_QUESTIONS,
  TYPESAFE_EVALUATED_MODEL,
} from '../ai/systemone-transport';
import {
  assertConnectionEnabledForDispatch,
} from '../ai/provider-connections';
import {
  completeModelCall,
} from '../db/repositories/classification-model-call-repo';
import {
  MODEL_CALL_STATUS,
  PROMPT_TEMPLATE_VERSIONS,
  RULE_VERSIONS,
  type ModelCallContext,
} from './model-operation-registry';
import {
  resolveModelRoute,
  ModelPolicyDeniedError,
  type ModelPolicyView,
} from './model-policy-gateway';
import {
  assertModelPlanCompatible,
  type RuntimeClassificationSnapshot,
} from './runtime-snapshot';
import { HeartbeatLostError } from './heartbeat-errors';
import {
  buildEvidenceTargetPacket,
  tokenGroundingSupport,
  resolveCanonicalAssertion,
  type EvidenceTargetPacket,
} from './evidence-targeting';
import { matchAttributeOptions } from './curation-target-matcher';
import { enrichProductDetails } from './detail-enrichment';
import { llmRankOptions } from './curation-target-ranker';
import type { ResolvedTarget, ResolvedTargetOption } from './curation-target-resolver';
import {
  CanonicalBrandEvidenceValueSchema,
  type ClassificationEvidence,
  type ProposalDerivation,
  type ProductAttributeConfig,
  type ClassificationProposal,
} from '../shared/schemas/classification';
import { hashCanonicalJson } from '../shared/stable-id';
import {
  MAX_ORDINARY_CHOICE_CANDIDATES,
  SYSTEMONE_MULTI_MIN_PROBABILITY,
  SYSTEMONE_MULTI_UNCERTAIN_FLOOR,
  SYSTEMONE_SINGLE_CHOICE_MIN_PROBABILITY,
  applyCardinalityLimit,
  assertSystemOneModelMatch,
  buildCandidateProbabilities,
  buildChoiceJudgmentDerivation,
  buildChoiceKeyMaps,
  buildNoulJudgmentDerivation,
  checkCardinalityTieAtBoundary,
  choiceKeyToCanonicalId,
  evidenceTextValue,
  fitStateToBudget,
  maxCandidateProbability,
  requireNoulAnswer,
  resolveDecisionRouteForOperation,
  runSingleChoiceDispatch,
  asEffectivePolicyView,
  insertPolicyDeniedTerminalCall,
  openDecisionModelCall,
  openSingleChoiceRequest,
  sanitizeQuestionIdSegment,
  sourceFieldOf,
  sortCandidatesByProbability,
  truncateSnippets,
} from './systemone-decision-core';
import { buildFieldAssignmentProposal } from './curation-target-proposal';

// ─── Versioned Constants ──────────────────────────────────────────────────────

const MAX_ORDINARY_ATTRIBUTE_CANDIDATES = MAX_ORDINARY_CHOICE_CANDIDATES; // 253

const NO_MATCH_CHOICE_KEY = 'no_match';
const INSUFFICIENT_EVIDENCE_CHOICE_KEY = 'insufficient_evidence';

/**
 * Development-fitted minimum probability for Jev Choice attribute selection.
 * An ungrounded option pick below 0.50 probability is an explicit semantic abstention.
 */
export const JEV_ATTRIBUTE_MIN_PROBABILITY = SYSTEMONE_SINGLE_CHOICE_MIN_PROBABILITY; // 0.50

/**
 * Development-fitted minimum probability for Jev Noul multi-value attribute selection.
 * For independent binary judgments, P(yes) >= 0.70 demonstrates explicit positive support.
 */
const JEV_MULTI_VALUE_MIN_PROBABILITY = SYSTEMONE_MULTI_MIN_PROBABILITY; // 0.70

/**
 * Floor below which all candidate probabilities indicate no fitting options in taxonomy.
 */
const JEV_MULTI_VALUE_UNCERTAIN_FLOOR = SYSTEMONE_MULTI_UNCERTAIN_FLOOR; // 0.40

/** Approved sources for direct product evidence (claims & composition). */
const DIRECT_EVIDENCE_SOURCES = new Set([
  'official_product_page',
  'visual_product_evidence',
  'catalog_product',
]);

const now = () => new Date().toISOString();

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AttributeDecisionParams {
  target: ResolvedTarget;
  cardinality: 'single' | 'multiple';
  evidence: ClassificationEvidence[];
  sku: string;
  runId: string;
  snapshot?: RuntimeClassificationSnapshot | null;
  modelPolicy?: ModelPolicyView | null;
  confidenceFloor?: number;
  assertHeld?: () => void;
  productContext?: {
    name?: string;
    brand?: string | null;
    productType?: string | null;
  };
  constraints?: {
    maxItems?: number;
    minItems?: number;
  };
}

export type AttributeDecisionStatus = 'resolved' | 'abstained' | 'failed';

export interface AttributeDecisionResult {
  status: AttributeDecisionStatus;
  targetId: string;
  value: string | null;
  values?: string[];
  confidence: number;
  selectedProbability: number | null;
  vendorConfidence: number | null;
  probabilityBasis: string | null;
  candidateProbabilities?: Record<string, number>;
  source: 'keyword' | 'llm' | 'jev' | 'invariant' | 'brand_resolved';
  abstentionCode?:
    | 'no_match'
    | 'insufficient_evidence'
    | 'low_probability'
    | 'candidate_limit_exceeded'
    | 'multi_value_unsupported'
    | 'unsupported_claim'
    | 'service_failure'
    | 'policy_denied'
    | 'cardinality_limit_exceeded'
    | 'ambiguous_prediction'
    | 'no_confident_match';
  abstentionReason?: string | null;
  derivation: ProposalDerivation;
  modelCallIds: string[];
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  hasConflict?: boolean;
  error?: unknown;
}

// ─── Bounded State Builder ───────────────────────────────────────────────────

interface BoundedAttributeState {
  sku: string;
  name: string;
  brand: string | null;
  productType: string | null;
  evidenceCount: number;
  evidenceText: string;
  snippets: string[];
}

type AttributeEvidenceSlot = 'name' | 'brand' | 'producttype';

interface AttributeStateAccumulator {
  name: string;
  brand: string | null;
  productType: string | null;
}

/**
 * All state slots one evidence record matches, in priority order. Guards stay
 * with the collector so the first-wins cascade order is preserved exactly.
 */
function matchingAttributeEvidenceSlots(
  sourceField: string,
  attributeId: string | null | undefined,
): AttributeEvidenceSlot[] {
  const slots: AttributeEvidenceSlot[] = [];
  if (sourceField.includes('name') || sourceField.includes('title')) slots.push('name');
  if (sourceField.includes('brand') || attributeId === 'brand') slots.push('brand');
  if (sourceField.includes('producttype') || attributeId === 'primary_product_type') slots.push('producttype');
  return slots;
}

/**
 * Try to place one evidence value into the first matching open slot.
 */
function tryPlaceAttributeSlot(
  acc: AttributeStateAccumulator,
  slot: AttributeEvidenceSlot,
  val: string,
  e: ClassificationEvidence,
): boolean {
  if (slot === 'name' && !acc.name) {
    acc.name = val;
    return true;
  }
  if (slot === 'brand' && !acc.brand) {
    acc.brand = typeof e.value === 'string' ? e.value : null;
    return true;
  }
  if (slot === 'producttype' && !acc.productType) {
    acc.productType = typeof e.value === 'string' ? e.value : null;
    return true;
  }
  return false;
}

/**
 * Collect name/brand/productType from permitted evidence (first wins),
 * seeded from the product context.
 */
/**
 * Place one evidence record's value into the accumulator (first wins).
 */
function placeAttributeEvidenceField(acc: AttributeStateAccumulator, e: ClassificationEvidence): void {
  const val = evidenceTextValue(e);
  const sourceField = sourceFieldOf(e);
  for (const slot of matchingAttributeEvidenceSlots(sourceField, e.attributeId)) {
    if (tryPlaceAttributeSlot(acc, slot, val, e)) break;
  }
}

function collectAttributeStateFields(
  evidence: ClassificationEvidence[],
  productContext?: { name?: string; brand?: string | null; productType?: string | null },
): AttributeStateAccumulator {
  const acc: AttributeStateAccumulator = {
    name: productContext?.name || '',
    brand: productContext?.brand ?? null,
    productType: productContext?.productType ?? null,
  };
  for (const e of evidence) {
    placeAttributeEvidenceField(acc, e);
  }
  return acc;
}

/**
 * Collect deduplicated snippet strings from permitted evidence.
 */
function collectAttributeSnippets(evidence: ClassificationEvidence[]): string[] {
  const snippets: string[] = [];
  for (const e of evidence) {
    if (e.snippet && !snippets.includes(e.snippet)) {
      snippets.push(e.snippet);
    } else if (typeof e.value === 'string' && e.value && !snippets.includes(e.value)) {
      snippets.push(e.value);
    }
  }
  return snippets;
}

/**
 * Filter evidence according to attribute eligibility.
 * E.g., if visualEvidenceEligibility is 'ineligible', exclude visual_product_evidence.
 */
function filterPermittedEvidence(
  evidence: ClassificationEvidence[],
  attribute?: ProductAttributeConfig | null,
): ClassificationEvidence[] {
  if (attribute?.visualEvidenceEligibility === 'ineligible') {
    return evidence.filter(e => e.source !== 'visual_product_evidence');
  }
  return evidence;
}

/**
 * Builds bounded structured state from target-specific permitted evidence, capped at 32k bytes.
 */
function buildAttributeState(
  evidence: ClassificationEvidence[],
  sku: string,
  productContext?: { name?: string; brand?: string | null; productType?: string | null },
): BoundedAttributeState {
  const collected = collectAttributeStateFields(evidence, productContext);
  const name = collected.name;
  const brand = collected.brand;
  const productType = collected.productType;
  const snippets = collectAttributeSnippets(evidence);

  const baseState: BoundedAttributeState = {
    sku,
    name: name || sku,
    brand,
    productType,
    snippets: truncateSnippets(snippets),
    evidenceText: snippets.slice(0, 15).join('; ').slice(0, 4000),
    evidenceCount: evidence.length,
  };

  fitStateToBudget(baseState, s => {
    s.snippets = s.snippets.slice(0, 5);
    s.evidenceText = s.evidenceText.slice(0, 1000);
  });

  return baseState;
}

// ─── Question Builder ─────────────────────────────────────────────────────────

export interface AttributeChoiceQuestionPlan {
  questionId: string;
  instructions: string;
  criteria: Record<string, string>;
  keyToIdMap: Map<string, string>;
  idToKeyMap: Map<string, string>;
}

export function buildAttributeChoiceQuestion(
  target: ResolvedTarget,
): AttributeChoiceQuestionPlan {
  const options = target.options;
  const criteria: Record<string, string> = {};
  const { keyToIdMap, idToKeyMap } = buildChoiceKeyMaps(criteria, options, 'opt');

  // Two dedicated abstention outcomes
  criteria[NO_MATCH_CHOICE_KEY] =
    `None of the specific ${target.config.label} options listed above apply to this product.`;
  criteria[INSUFFICIENT_EVIDENCE_CHOICE_KEY] =
    `The evidence provided is insufficient, ambiguous, or lacks essential product details to determine the ${target.config.label} with confidence.`;

  const instructions =
    `Select the ${target.config.label} that best describes this product from the available choices based strictly on the provided product evidence. If none of the specific options apply to the product, select "${NO_MATCH_CHOICE_KEY}". If the evidence does not provide enough information to determine the value with confidence, select "${INSUFFICIENT_EVIDENCE_CHOICE_KEY}".`;

  const targetAttrId = target.config.attributeId ?? target.config.id;
  const questionId = `attr_${targetAttrId}`;

  return {
    questionId,
    instructions,
    criteria,
    keyToIdMap,
    idToKeyMap,
  };
}

export interface AttributeNoulQuestionPlan {
  questionId: string;
  targetId: string;
  optionValue: string;
  optionLabel: string;
  optionIndex: number;
  instructions: string;
  criteria: { true: string; false: string };
}

export function buildAttributeNoulQuestions(
  target: ResolvedTarget,
  sku: string,
  productContext?: { name?: string; brand?: string | null; productType?: string | null },
): AttributeNoulQuestionPlan[] {
  const attrId = target.config.attributeId ?? target.config.id;
  const cleanAttrId = sanitizeQuestionIdSegment(attrId);
  const targetLabel = target.config.label;
  const options = target.options;
  const name = productContext?.name || sku;

  return options.map((opt, i) => {
    const questionId = `attr_${cleanAttrId}__val_${i}`;
    const instructions = `Does the product "${name}" (SKU ${sku}) have the attribute "${targetLabel}" with value "${opt.label}" based directly on the provided evidence?`;
    const criteria = {
      true: `The product evidence directly and clearly indicates or confirms "${opt.label}" for "${targetLabel}".`,
      false: `The product evidence does not indicate "${opt.label}", indicates a different value, or evidence is absent or insufficient.`,
    };
    return {
      questionId,
      targetId: attrId,
      optionValue: opt.value,
      optionLabel: opt.label,
      optionIndex: i,
      instructions,
      criteria,
    };
  });
}

export interface MultiValueCandidateEvaluation {
  optionValue: string;
  optionLabel: string;
  optionIndex: number;
  prob: number;
}

export interface EvaluateMultiValuePolicyParams {
  target: ResolvedTarget;
  candidates: MultiValueCandidateEvaluation[];
  permittedEvidence: ClassificationEvidence[];
  catalogField: string | null;
  maxItems?: number;
  minItems?: number;
}

export type MultiValuePolicyOutcome =
  | {
      outcome: 'resolved';
      selectedValues: string[];
      topProb: number;
      avgProb: number;
      candidateProbabilities: Record<string, number>;
      groundedPacket: EvidenceTargetPacket;
    }
  | {
      outcome: 'abstained';
      abstentionCode:
        | 'no_match'
        | 'insufficient_evidence'
        | 'low_probability'
        | 'cardinality_limit_exceeded'
        | 'ambiguous_prediction'
        | 'unsupported_claim';
      abstentionReason: string;
      topProb: number | null;
      candidateProbabilities: Record<string, number>;
      groundedPacket: EvidenceTargetPacket;
    };

function buildEmptyMultiValuePacket(
  target: ResolvedTarget,
  permittedEvidence: ClassificationEvidence[],
  catalogField: string | null,
): EvidenceTargetPacket {
  return buildEvidenceTargetPacket(permittedEvidence, {
    attributeId: target.config.attributeId ?? target.config.id,
    sourceField: catalogField,
    selectionMode: 'multiple',
    proposedValue: [],
    aliases: target.attribute?.valueAliases ?? [],
    isGroundingSupport: tokenGroundingSupport,
  });
}

/**
 * No-qualifying-candidate outcome for multi-value policy: no-fit vs
 * insufficient-evidence by the 0.40 uncertain floor. Null when candidates qualify.
 */
function resolveMultiValueEmptyOutcome(input: {
  target: ResolvedTarget;
  qualifying: MultiValueCandidateEvaluation[];
  candidates: MultiValueCandidateEvaluation[];
  permittedEvidence: ClassificationEvidence[];
  catalogField: string | null;
  targetLabel: string;
  threshold: number;
  candidateProbabilities: Record<string, number>;
}): MultiValuePolicyOutcome | null {
  const { target, qualifying, candidates, permittedEvidence, catalogField, targetLabel, threshold, candidateProbabilities } = input;
  if (qualifying.length !== 0) return null;
  const maxP = maxCandidateProbability(candidates);
  const emptyPacket = buildEmptyMultiValuePacket(target, permittedEvidence, catalogField);

  if (maxP < JEV_MULTI_VALUE_UNCERTAIN_FLOOR) {
    return {
      outcome: 'abstained',
      abstentionCode: 'no_match',
      abstentionReason: `no_fit: No matching option in the configured taxonomy applies to this product for "${targetLabel}".`,
      topProb: maxP > 0 ? maxP : null,
      candidateProbabilities,
      groundedPacket: emptyPacket,
    };
  }
  return {
    outcome: 'abstained',
    abstentionCode: 'insufficient_evidence',
    abstentionReason: `insufficient_evidence: Product evidence is insufficient to determine "${targetLabel}" with confidence (highest probability ${maxP.toFixed(3)} is below required threshold ${threshold.toFixed(2)}).`,
    topProb: maxP > 0 ? maxP : null,
    candidateProbabilities,
    groundedPacket: emptyPacket,
  };
}

/**
 * Minimum-cardinality outcome for multi-value policy. Null when satisfied.
 */
function resolveMultiValueMinItemsOutcome(input: {
  target: ResolvedTarget;
  qualifying: MultiValueCandidateEvaluation[];
  permittedEvidence: ClassificationEvidence[];
  catalogField: string | null;
  minItems?: number;
  candidateProbabilities: Record<string, number>;
}): MultiValuePolicyOutcome | null {
  const { target, qualifying, permittedEvidence, catalogField, minItems, candidateProbabilities } = input;
  // Minimum cardinality check if specified
  if (typeof minItems === 'number' && minItems > 0 && qualifying.length < minItems) {
    const emptyPacket = buildEmptyMultiValuePacket(target, permittedEvidence, catalogField);
    return {
      outcome: 'abstained',
      abstentionCode: 'insufficient_evidence',
      abstentionReason: `insufficient_evidence: Minimum required values (${minItems}) not met (only ${qualifying.length} qualified).`,
      topProb: qualifying[0]?.prob ?? null,
      candidateProbabilities,
      groundedPacket: emptyPacket,
    };
  }
  return null;
}

type MultiValueCardinalityOutcome =
  | { abstained: MultiValuePolicyOutcome; qualifying?: undefined }
  | { abstained?: undefined; qualifying: MultiValueCandidateEvaluation[] };

/**
 * Maximum-cardinality outcome for multi-value policy: unresolvable ties at
 * the boundary abstain, otherwise the list truncates to the limit.
 */
function applyMultiValueCardinalityLimit(input: {
  target: ResolvedTarget;
  qualifying: MultiValueCandidateEvaluation[];
  permittedEvidence: ClassificationEvidence[];
  catalogField: string | null;
  maxItems?: number;
  candidateProbabilities: Record<string, number>;
}): MultiValueCardinalityOutcome {
  const { target, permittedEvidence, catalogField, maxItems, candidateProbabilities } = input;
  let qualifying = input.qualifying;
  // Cardinality limit check
  if (typeof maxItems === 'number' && maxItems > 0 && qualifying.length > maxItems) {
    const tiedProb = checkCardinalityTieAtBoundary(qualifying, maxItems);
    if (tiedProb !== null) {
      const emptyPacket = buildEmptyMultiValuePacket(target, permittedEvidence, catalogField);
      return {
        abstained: {
          outcome: 'abstained',
          abstentionCode: 'cardinality_limit_exceeded',
          abstentionReason: `cardinality_limit_exceeded: Ambiguity at cardinality limit (${maxItems}): multiple candidates share identical probability (${tiedProb.toFixed(3)}) at the selection boundary.`,
          topProb: qualifying[0].prob,
          candidateProbabilities,
          groundedPacket: emptyPacket,
        },
      };
    }
    qualifying = applyCardinalityLimit(qualifying, maxItems);
  }
  return { qualifying };
}

type MultiValueClaimOutcome =
  | { abstained: MultiValuePolicyOutcome; qualifying?: undefined }
  | { abstained?: undefined; qualifying: MultiValueCandidateEvaluation[] };

/**
 * Claims and composition safeguard (AC 5) for multi-value policy: qualifying
 * values without target-specific direct product evidence are dropped, and an
 * entirely unsupported set abstains instead of resolving.
 */
/**
 * True when one candidate has target-specific direct product evidence.
 */
function hasDirectCandidateSupport(input: {
  permittedEvidence: ClassificationEvidence[];
  attrId: string;
  catalogField: string | null;
  attribute: ResolvedTarget['attribute'];
  candidate: MultiValueCandidateEvaluation;
}): boolean {
  const { permittedEvidence, attrId, catalogField, attribute, candidate } = input;
  const candPacket = buildEvidenceTargetPacket(permittedEvidence, {
    attributeId: attrId,
    sourceField: catalogField,
    selectionMode: 'single',
    proposedValue: candidate.optionValue,
    aliases: attribute?.valueAliases ?? [],
    isGroundingSupport: tokenGroundingSupport,
  });
  return candPacket.supporting.some(e => DIRECT_EVIDENCE_SOURCES.has(e.source));
}

function applyMultiValueClaimSafeguard(input: {
  target: ResolvedTarget;
  qualifying: MultiValueCandidateEvaluation[];
  permittedEvidence: ClassificationEvidence[];
  catalogField: string | null;
  attribute: ResolvedTarget['attribute'];
  attrId: string;
  targetLabel: string;
  candidateProbabilities: Record<string, number>;
}): MultiValueClaimOutcome {
  const { target, qualifying, permittedEvidence, catalogField, attribute, attrId, targetLabel, candidateProbabilities } = input;
  // Claims and composition safeguard (AC 5)
  if (attribute?.isClaim === true || attribute?.isCompositionAttribute === true) {
    const directEligible = qualifying.filter(c =>
      hasDirectCandidateSupport({ permittedEvidence, attrId, catalogField, attribute, candidate: c }),
    );

    if (directEligible.length === 0) {
      const emptyPacket = buildEmptyMultiValuePacket(target, permittedEvidence, catalogField);
      return {
        abstained: {
          outcome: 'abstained',
          abstentionCode: 'unsupported_claim',
          abstentionReason: `unsupported_claim: "${targetLabel}" requires target-specific direct product evidence, but none was found. A high probability cannot authorize an unsupported claim or infer a claim from absence.`,
          topProb: qualifying[0]?.prob ?? null,
          candidateProbabilities,
          groundedPacket: emptyPacket,
        },
      };
    }
    return { qualifying: directEligible };
  }
  return { qualifying };
}

export function evaluateMultiValueSelectionPolicy(
  params: EvaluateMultiValuePolicyParams,
): MultiValuePolicyOutcome {
  const { target, candidates, permittedEvidence, catalogField, maxItems, minItems } = params;
  const attrId = target.config.attributeId ?? target.config.id;
  const attribute = target.attribute;
  const targetLabel = target.config.label;

  const candidateProbabilities = buildCandidateProbabilities(candidates);

  const threshold = JEV_MULTI_VALUE_MIN_PROBABILITY; // 0.70
  let qualifying = candidates.filter(c => c.prob >= threshold);

  const emptyOutcome = resolveMultiValueEmptyOutcome({
    target,
    qualifying,
    candidates,
    permittedEvidence,
    catalogField,
    targetLabel,
    threshold,
    candidateProbabilities,
  });
  if (emptyOutcome) return emptyOutcome;

  const minItemsOutcome = resolveMultiValueMinItemsOutcome({
    target,
    qualifying,
    permittedEvidence,
    catalogField,
    minItems,
    candidateProbabilities,
  });
  if (minItemsOutcome) return minItemsOutcome;

  // Deterministic ordering: P(yes) desc, then original optionIndex asc
  qualifying = sortCandidatesByProbability(qualifying, c => c.optionIndex);

  const cardinality = applyMultiValueCardinalityLimit({
    target,
    qualifying,
    permittedEvidence,
    catalogField,
    maxItems,
    candidateProbabilities,
  });
  if (cardinality.abstained) return cardinality.abstained;
  qualifying = cardinality.qualifying;

  const claimCheck = applyMultiValueClaimSafeguard({
    target,
    qualifying,
    permittedEvidence,
    catalogField,
    attribute,
    attrId,
    targetLabel,
    candidateProbabilities,
  });
  if (claimCheck.abstained) return claimCheck.abstained;
  qualifying = claimCheck.qualifying;

  const selectedValues = [...new Set(qualifying.map(c => c.optionValue))];
  const groundedPacket = buildEvidenceTargetPacket(permittedEvidence, {
    attributeId: attrId,
    sourceField: catalogField,
    selectionMode: 'multiple',
    proposedValue: selectedValues,
    aliases: attribute?.valueAliases ?? [],
    isGroundingSupport: tokenGroundingSupport,
  });

  const topProb = qualifying[0].prob;
  const avgProb = qualifying.reduce((sum, c) => sum + c.prob, 0) / qualifying.length;

  return {
    outcome: 'resolved',
    selectedValues,
    topProb,
    avgProb,
    candidateProbabilities,
    groundedPacket,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Early Choice abstentions for single attributes (no_match / insufficient
 * evidence). Returns a terminal result when they apply, otherwise null so the
 * caller proceeds to canonical mapping (unknown keys must still throw).
 */
function interpretAttributeEarlyAbstention(input: {
  choiceKey: string;
  selectedProbability: number;
  vendorConfidence: number;
  questionPlan: AttributeChoiceQuestionPlan;
  target: ResolvedTarget;
  attrId: string;
  callId: string;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): AttributeDecisionResult | null {
  const {
    choiceKey,
    selectedProbability,
    vendorConfidence,
    questionPlan,
    target,
    attrId,
    callId,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  } = input;
    if (choiceKey === NO_MATCH_CHOICE_KEY) {
      return {
        status: 'abstained',
        targetId: attrId,
        value: null,
        confidence: 0,
        selectedProbability,
        vendorConfidence,
        probabilityBasis: 'choice_probability',
        source: 'jev',
        abstentionCode: 'no_match',
        abstentionReason: `no_fit: No matching option in the configured taxonomy applies to this product for "${target.config.label}".`,
        derivation: buildChoiceJudgmentDerivation(questionPlan.questionId, selectedProbability, vendorConfidence, 'no_match'),
        modelCallIds: [callId],
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      };
    }

    if (choiceKey === INSUFFICIENT_EVIDENCE_CHOICE_KEY) {
      return {
        status: 'abstained',
        targetId: attrId,
        value: null,
        confidence: 0,
        selectedProbability,
        vendorConfidence,
        probabilityBasis: 'choice_probability',
        source: 'jev',
        abstentionCode: 'insufficient_evidence',
        abstentionReason: `insufficient_evidence: Product evidence is insufficient to determine "${target.config.label}" with confidence.`,
        derivation: buildChoiceJudgmentDerivation(questionPlan.questionId, selectedProbability, vendorConfidence, 'insufficient_evidence'),
        modelCallIds: [callId],
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      };
    }

  return null;
}

/**
 * Post-mapping eligibility for single attributes: the 0.50 probability floor
 * plus the claims/composition direct-evidence safeguard.
 * Returns a terminal abstention when they apply, otherwise null.
 */
type AttributeEligibilityOutcome =
  | { outcome: 'abstained'; result: AttributeDecisionResult }
  | { outcome: 'continue'; groundedPacket: EvidenceTargetPacket };

function interpretAttributeEligibility(input: {
  canonicalValue: string;
  selectedProbability: number;
  vendorConfidence: number;
  questionPlan: AttributeChoiceQuestionPlan;
  target: ResolvedTarget;
  attribute: ResolvedTarget['attribute'];
  attrId: string;
  callId: string;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  permittedEvidence: ClassificationEvidence[];
  catalogField: string | null;
}): AttributeEligibilityOutcome {
  const {
    canonicalValue,
    selectedProbability,
    vendorConfidence,
    questionPlan,
    target,
    attribute,
    attrId,
    callId,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
    permittedEvidence,
    catalogField,
  } = input;
    // Check development-fitted eligibility floor (0.50)
    if (selectedProbability < JEV_ATTRIBUTE_MIN_PROBABILITY) {
      return { outcome: 'abstained', result: {
        status: 'abstained',
        targetId: attrId,
        value: null,
        confidence: 0,
        selectedProbability,
        vendorConfidence,
        probabilityBasis: 'choice_probability',
        source: 'jev',
        abstentionCode: 'low_probability',
        abstentionReason: `low_probability: Selected attribute value "${canonicalValue}" probability (${selectedProbability.toFixed(3)}) is below required threshold (${JEV_ATTRIBUTE_MIN_PROBABILITY}).`,
        derivation: buildChoiceJudgmentDerivation(questionPlan.questionId, selectedProbability, vendorConfidence, 'low_probability'),
        modelCallIds: [callId],
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
        } };
    }

    // Reground with the chosen value
    const groundedPacket = buildEvidenceTargetPacket(permittedEvidence, {
      attributeId: attrId,
      sourceField: catalogField,
      selectionMode: 'single',
      proposedValue: canonicalValue,
      aliases: attribute?.valueAliases ?? [],
      isGroundingSupport: tokenGroundingSupport,
    });

    // AC 5: Claims and composition safeguard
    if (attribute?.isClaim === true || attribute?.isCompositionAttribute === true) {
      const hasDirectSupporting = groundedPacket.supporting.some(
        e => DIRECT_EVIDENCE_SOURCES.has(e.source),
      );
      if (!hasDirectSupporting) {
        return { outcome: 'abstained', result: {
          status: 'abstained',
          targetId: attrId,
          value: null,
          confidence: 0,
          selectedProbability,
          vendorConfidence,
          probabilityBasis: 'choice_probability',
          source: 'jev',
          abstentionCode: 'unsupported_claim',
          abstentionReason: `unsupported_claim: "${target.config.label}" requires target-specific direct product evidence, but none was found. A high probability cannot authorize an unsupported claim or infer a claim from absence.`,
          derivation: buildChoiceJudgmentDerivation(questionPlan.questionId, selectedProbability, vendorConfidence, 'unsupported_claim'),
          modelCallIds: [callId],
          evidenceIds: groundedPacket.evidenceIds,
          supportingEvidenceIds: groundedPacket.supportingEvidenceIds,
          contradictingEvidenceIds: groundedPacket.contradictingEvidenceIds,
          } };
      }
    }

  return { outcome: 'continue', groundedPacket };
}

/**
 * Execute the multi-value Noul dispatch for one attribute: per-option binary
 * questions in bounded chunks, fail-closed batch collection, then the frozen
 * multi-value selection policy.
 */
/**
 * Dispatch one multi-value Noul chunk with audit rows, collecting that
 * chunk's candidate probabilities. Chunk failures are fail-closed with an
 * incomplete-batch error.
 */
/**
 * Open one Noul chunk request: hashing plus the durable audit start row.
 */
function openAttributeNoulChunkCall(input: {
  questionsRecord: Record<string, { type: 'noul'; instructions: string; criteria: { true: string; false: string } }>;
  state: BoundedAttributeState;
  route: ReturnType<typeof resolveModelRoute>;
  runId: string;
  ctx: ModelCallContext;
  effectivePolicy: ModelPolicyView;
  assertHeld?: () => void;
}): {
  request: { model: string; state: BoundedAttributeState; questions: Record<string, { type: 'noul'; instructions: string; criteria: { true: string; false: string } }> };
  callId: string;
} {
  const { questionsRecord, state, route, runId, ctx, effectivePolicy, assertHeld } = input;
  const request = {
    model: route.model || TYPESAFE_EVALUATED_MODEL,
    state,
    questions: questionsRecord,
  };

  assertHeld?.();
  const promptHash = hashCanonicalJson(request);

  const callId = openDecisionModelCall({
    runId,
    ctx,
    route,
    effectivePolicyDigest: effectivePolicy.policyDigest,
    promptHash,
  });

  return { request, callId };
}

/**
 * Collect one dispatched Noul chunk's candidate probabilities (strict answer
 * typing per question; mismatches throw into fail-closed handling).
 */
function collectNoulChunkCandidates(input: {
  chunk: AttributeNoulQuestionPlan[];
  answers: Record<string, any>;
}): MultiValueCandidateEvaluation[] {
  const { chunk, answers } = input;
  const candidates: MultiValueCandidateEvaluation[] = [];
  for (const plan of chunk) {
    const answer = requireNoulAnswer(answers, plan.questionId);
    candidates.push({
      optionValue: plan.optionValue,
      optionLabel: plan.optionLabel,
      optionIndex: plan.optionIndex,
      prob: answer.noul,
    });
  }
  return candidates;
}

async function dispatchAttributeNoulChunk(input: {
  chunk: AttributeNoulQuestionPlan[];
  state: BoundedAttributeState;
  route: ReturnType<typeof resolveModelRoute>;
  jevConn: any;
  ctx: ModelCallContext;
  effectivePolicy: ModelPolicyView;
  assertHeld?: () => void;
  runId: string;
  attrId: string;
  cleanAttrId: string;
  packet: EvidenceTargetPacket;
  modelCallIds: string[];
}): Promise<{ candidates: MultiValueCandidateEvaluation[] } | { failed: AttributeDecisionResult }> {
  const { chunk, state, route, jevConn, ctx, effectivePolicy, assertHeld, runId, attrId, cleanAttrId, packet, modelCallIds } = input;
  const chunkCandidates: MultiValueCandidateEvaluation[] = [];
      const questionsRecord: Record<string, { type: 'noul'; instructions: string; criteria: { true: string; false: string } }> = {};
      for (const plan of chunk) {
        questionsRecord[plan.questionId] = {
          type: 'noul',
          instructions: plan.instructions,
          criteria: plan.criteria,
        };
      }

      const chunkCall = openAttributeNoulChunkCall({
        questionsRecord,
        state,
        route,
        runId,
        ctx,
        effectivePolicy,
        assertHeld,
      });
      const { request, callId } = chunkCall;
      modelCallIds.push(callId);

      const startedAt = Date.now();
      try {
        assertHeld?.();
        const result = await dispatchSystemOne(jevConn as any, request);
        assertHeld?.();

        assertSystemOneModelMatch(request.model, result.returnedModel);

        const durationMs = Date.now() - startedAt;
        completeModelCall(callId, {
          status: MODEL_CALL_STATUS.success,
          endedAt: now(),
          durationMs,
          promptTokens: result.usage.inputTokens,
          completionTokens: result.usage.outputTokens,
          resolvedModel: result.returnedModel,
          typedResultMetadata: {
            batchedQuestions: Object.keys(questionsRecord),
            resolvedModel: result.returnedModel,
            basis: 'noul_probability',
          },
        });

        chunkCandidates.push(...collectNoulChunkCandidates({ chunk, answers: result.answers }));
      } catch (err) {
        if (err instanceof HeartbeatLostError) throw err;

        assertHeld?.();
        const durationMs = Date.now() - startedAt;
        completeModelCall(callId, {
          status: MODEL_CALL_STATUS.failed,
          endedAt: now(),
          durationMs,
          errorMessage: err instanceof Error ? err.message : String(err),
        });

        // AC 3: Missing answers or unprocessed candidate batches cannot silently produce a complete-looking set (fail closed on incomplete batches)
        return { failed: {
          status: 'failed',
          targetId: attrId,
          value: null,
          values: undefined,
          confidence: 0,
          selectedProbability: null,
          vendorConfidence: null,
          probabilityBasis: null,
          source: 'jev',
          abstentionCode: 'service_failure',
          abstentionReason: `service_failure: Incomplete candidate batch: ${err instanceof Error ? err.message : String(err)}`,
          derivation: buildNoulJudgmentDerivation(`attr_${cleanAttrId}`, null, { abstentionCode: 'service_failure' }),
          modelCallIds,
          evidenceIds: packet.evidenceIds,
          supportingEvidenceIds: packet.supportingEvidenceIds,
          contradictingEvidenceIds: packet.contradictingEvidenceIds,
          error: err,
        } };
      }
  return { candidates: chunkCandidates };
}

async function executeAttributeMultiValueNoul(input: {
  target: ResolvedTarget;
  permittedEvidence: ClassificationEvidence[];
  sku: string;
  productContext: AttributeDecisionParams['productContext'];
  catalogField: string | null;
  attrId: string;
  cleanAttrId: string;
  route: ReturnType<typeof resolveModelRoute>;
  jevConn: any;
  ctx: ModelCallContext;
  effectivePolicy: ModelPolicyView;
  assertHeld?: () => void;
  runId: string;
  packet: EvidenceTargetPacket;
  constraints: AttributeDecisionParams['constraints'];
}): Promise<AttributeDecisionResult> {
  const {
    target,
    permittedEvidence,
    sku,
    productContext,
    catalogField,
    attrId,
    cleanAttrId,
    route,
    jevConn,
    ctx,
    effectivePolicy,
    assertHeld,
    runId,
    packet,
    constraints,
  } = input;
    const noulPlans = buildAttributeNoulQuestions(target, sku, productContext);
    const state = buildAttributeState(permittedEvidence, sku, productContext);

    const CHUNK_SIZE = SYSTEMONE_MAX_QUESTIONS;
    const noulChunks: AttributeNoulQuestionPlan[][] = [];
    for (let i = 0; i < noulPlans.length; i += CHUNK_SIZE) {
      noulChunks.push(noulPlans.slice(i, i + CHUNK_SIZE));
    }

    const candidates: MultiValueCandidateEvaluation[] = [];
    const modelCallIds: string[] = [];

    for (const chunk of noulChunks) {
      const dispatched = await dispatchAttributeNoulChunk({
        chunk,
        state,
        route,
        jevConn,
        ctx,
        effectivePolicy,
        assertHeld,
        runId,
        attrId,
        cleanAttrId,
        packet,
        modelCallIds,
      });
      if ('failed' in dispatched) return dispatched.failed;
      candidates.push(...dispatched.candidates);
    }
    // All candidate questions successfully answered: apply evaluated frozen selection policy
    const policyOutcome = evaluateMultiValueSelectionPolicy({
      target,
      candidates,
      permittedEvidence,
      catalogField,
      maxItems: constraints?.maxItems,
      minItems: constraints?.minItems,
    });

    if (policyOutcome.outcome === 'abstained') {
      return {
        status: 'abstained',
        targetId: attrId,
        value: null,
        values: undefined,
        confidence: 0,
        selectedProbability: policyOutcome.topProb,
        vendorConfidence: null,
        probabilityBasis: 'noul_probability',
        candidateProbabilities: policyOutcome.candidateProbabilities,
        source: 'jev',
        abstentionCode: policyOutcome.abstentionCode,
        abstentionReason: policyOutcome.abstentionReason,
        derivation: buildNoulJudgmentDerivation(`attr_${cleanAttrId}`, policyOutcome.topProb, { abstentionCode: policyOutcome.abstentionCode, candidateProbabilities: policyOutcome.candidateProbabilities }),
        modelCallIds,
        evidenceIds: policyOutcome.groundedPacket.evidenceIds,
        supportingEvidenceIds: policyOutcome.groundedPacket.supportingEvidenceIds,
        contradictingEvidenceIds: policyOutcome.groundedPacket.contradictingEvidenceIds,
      };
    }

    return {
      status: 'resolved',
      targetId: attrId,
      value: policyOutcome.selectedValues.join(', '),
      values: policyOutcome.selectedValues,
      confidence: policyOutcome.topProb,
      selectedProbability: policyOutcome.topProb,
      vendorConfidence: null,
      probabilityBasis: 'noul_probability',
      candidateProbabilities: policyOutcome.candidateProbabilities,
      source: 'jev',
      derivation: buildNoulJudgmentDerivation(`attr_${cleanAttrId}`, policyOutcome.topProb, { candidateProbabilities: policyOutcome.candidateProbabilities }),
      modelCallIds,
      evidenceIds: policyOutcome.groundedPacket.evidenceIds,
      supportingEvidenceIds: policyOutcome.groundedPacket.supportingEvidenceIds,
      contradictingEvidenceIds: policyOutcome.groundedPacket.contradictingEvidenceIds,
      hasConflict: policyOutcome.groundedPacket.hasConflict,
    };
}

/**
 * Legacy chat-LLM fallback for attributes (OpenAI / Ollama / DeepSeek).
 * Used only when the frozen route is not a SystemOne provider.
 */
/**
 * Invoke the legacy chat-LLM ranker for attributes.
 */
async function callAttributeLegacyRanker(input: {
  target: ResolvedTarget;
  cardinality: AttributeDecisionParams['cardinality'];
  options: ResolvedTargetOption[];
  text: string;
  effectivePolicy: ModelPolicyView | null;
  snapshot: RuntimeClassificationSnapshot | null | undefined;
  runId: string;
  assertHeld?: () => void;
}): Promise<Awaited<ReturnType<typeof llmRankOptions>>> {
  const { target, cardinality, options, text, effectivePolicy, snapshot, runId, assertHeld } = input;
    const llmResult = await llmRankOptions({
      targetLabel: target.config.label,
      options,
      selectionMode: cardinality,
      evidenceText: text,
      task: 'attribute_value_classification',
      modelPolicy: effectivePolicy,
      protectedOperation: 'attribute_ranking',
      ...(snapshot
        ? {
            modelCall: {
              runId,
              snapshotHash: snapshot.snapshotHash,
              stage: 'product_attribute_proposals',
              operation: 'attribute_ranking',
              attempt: 1,
              promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS.attribute_ranking,
              ruleVersion: RULE_VERSIONS.attribute_ranking,
            },
            snapshot,
          }
        : {}),
      assertHeld,
    });

  return llmResult;
}

/**
 * Map one legacy chat-LLM ranker result to a terminal attribute decision.
 */
function mapAttributeLlmResult(input: {
  llmResult: Awaited<ReturnType<typeof llmRankOptions>>;
  target: ResolvedTarget;
  cardinality: AttributeDecisionParams['cardinality'];
  attrId: string;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): AttributeDecisionResult {
  const { llmResult, target, cardinality, attrId, evidenceIds, supportingEvidenceIds, contradictingEvidenceIds } = input;
    if (!llmResult || llmResult.values.length === 0) {
      return {
        status: 'abstained',
        targetId: attrId,
        value: null,
        confidence: 0,
        selectedProbability: null,
        vendorConfidence: null,
        probabilityBasis: null,
        source: 'llm',
        abstentionCode: 'no_confident_match',
        abstentionReason: `No confident LLM match found for "${target.config.label}".`,
        derivation: { kind: 'llm' },
        modelCallIds: llmResult?.modelCallIds ?? [],
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      };
    }

    if (cardinality === 'multiple') {
      return {
        status: 'resolved',
        targetId: attrId,
        value: llmResult.values.join(', '),
        values: llmResult.values,
        confidence: llmResult.confidence,
        selectedProbability: null,
        vendorConfidence: null,
        probabilityBasis: 'llm_score',
        source: 'llm',
        derivation: { kind: 'llm' },
        modelCallIds: llmResult.modelCallIds ?? [],
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      };
    }

    const chosenVal = llmResult.values[0];
    return {
      status: 'resolved',
      targetId: attrId,
      value: chosenVal,
      confidence: llmResult.confidence,
      selectedProbability: null,
      vendorConfidence: null,
      probabilityBasis: 'llm_score',
      source: 'llm',
      derivation: { kind: 'llm' },
      modelCallIds: llmResult.modelCallIds ?? [],
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    };
}

async function executeAttributeLegacyFallback(input: {
  target: ResolvedTarget;
  cardinality: AttributeDecisionParams['cardinality'];
  options: ResolvedTargetOption[];
  text: string;
  effectivePolicy: ModelPolicyView | null;
  snapshot: RuntimeClassificationSnapshot | null | undefined;
  runId: string;
  assertHeld?: () => void;
  attrId: string;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): Promise<AttributeDecisionResult> {
  const {
    target,
    cardinality,
    options,
    text,
    effectivePolicy,
    snapshot,
    runId,
    assertHeld,
    attrId,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  } = input;
  if (!text || text.trim().length === 0) {
    return {
      status: 'abstained',
      targetId: attrId,
      value: null,
      confidence: 0,
      selectedProbability: null,
      vendorConfidence: null,
      probabilityBasis: null,
      source: 'llm',
      abstentionCode: 'insufficient_evidence',
      abstentionReason: `No evidence text available for "${target.config.label}".`,
      derivation: { kind: 'llm' },
      modelCallIds: [],
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    };
  }

  const llmResult = await callAttributeLegacyRanker({
    target,
    cardinality,
    options,
    text,
    effectivePolicy,
    snapshot,
    runId,
    assertHeld,
  });
  return mapAttributeLlmResult({
    llmResult,
    target,
    cardinality,
    attrId,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  });
}

type AttributeSinglePreparation = {
  questionPlan: AttributeChoiceQuestionPlan;
  request: { model: string; state: BoundedAttributeState; questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }> };
  callId: string;
  startedAt: number;
};

/**
 * Prepare one single-choice Jev request: question, bounded state, and the
 * durable audit start row.
 */
function prepareAttributeSingleChoice(input: {
  target: ResolvedTarget;
  permittedEvidence: ClassificationEvidence[];
  sku: string;
  productContext: AttributeDecisionParams['productContext'];
  route: ReturnType<typeof resolveModelRoute>;
  runId: string;
  ctx: ModelCallContext;
  effectivePolicy: ModelPolicyView;
}): AttributeSinglePreparation {
  const { target, permittedEvidence, sku, productContext, route, runId, ctx, effectivePolicy } = input;
  // Build question and bounded state
  const questionPlan = buildAttributeChoiceQuestion(target);
  const state = buildAttributeState(permittedEvidence, sku, productContext);

  const opened = openSingleChoiceRequest({
    route,
    state,
    questionPlan,
    runId,
    ctx,
    effectivePolicyDigest: effectivePolicy.policyDigest,
  });

  return { questionPlan, ...opened };
}

/**
 * Execute the single-choice Jev path for one attribute: question + bounded
 * state, protected dispatch with audit rows, early abstentions, canonical
 * mapping, regrounding, eligibility, and resolution.
 */
/**
 * Run one prepared single-choice dispatch with audit completion, then early
 * abstention, mapping, eligibility, and resolution.
 */
/**
 * Record one failed single-choice dispatch (no post-loss writes on lease loss).
 */
function failAttributeSingleDispatch(input: {
  err: unknown;
  callId: string;
  startedAt: number;
  assertHeld?: () => void;
  questionPlan: AttributeChoiceQuestionPlan;
  attrId: string;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): AttributeDecisionResult {
  const { err, callId, startedAt, assertHeld, questionPlan, attrId, evidenceIds, supportingEvidenceIds, contradictingEvidenceIds } = input;
  if (err instanceof HeartbeatLostError) throw err;

  assertHeld?.();
  const durationMs = Date.now() - startedAt;
  completeModelCall(callId, {
    status: MODEL_CALL_STATUS.failed,
    endedAt: now(),
    durationMs,
    errorMessage: err instanceof Error ? err.message : String(err),
  });

  return {
    status: 'failed',
    targetId: attrId,
    value: null,
    confidence: 0,
    selectedProbability: null,
    vendorConfidence: null,
    probabilityBasis: null,
    source: 'jev',
    abstentionCode: 'service_failure',
    abstentionReason: `service_failure: ${err instanceof Error ? err.message : String(err)}`,
    derivation: buildChoiceJudgmentDerivation(questionPlan.questionId, null, null, 'service_failure'),
    modelCallIds: [callId],
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
    error: err,
  };
}

async function runAttributeSingleDispatch(input: {
  jevConn: any;
  request: { model: string; state: BoundedAttributeState; questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }> };
  questionPlan: AttributeChoiceQuestionPlan;
  callId: string;
  assertHeld?: () => void;
  startedAt: number;
  target: ResolvedTarget;
  attribute: ResolvedTarget['attribute'];
  attrId: string;
  catalogField: string | null;
  permittedEvidence: ClassificationEvidence[];
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): Promise<AttributeDecisionResult> {
  const {
    jevConn,
    request,
    questionPlan,
    callId,
    assertHeld,
    startedAt,
    target,
    attribute,
    attrId,
    catalogField,
    permittedEvidence,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  } = input;
  return runSingleChoiceDispatch({
    jevConn,
    request,
    questionPlan,
    callId,
    assertHeld,
    startedAt,
    interpret: ({ choiceKey, selectedProbability, vendorConfidence }) => {
    const earlyAbstention = interpretAttributeEarlyAbstention({
      choiceKey,
      selectedProbability,
      vendorConfidence,
      questionPlan,
      target,
      attrId,
      callId,
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    });
    if (earlyAbstention) return earlyAbstention;

    const canonicalValue = choiceKeyToCanonicalId(questionPlan.keyToIdMap, choiceKey, 'option value');

    const eligibility = interpretAttributeEligibility({
      canonicalValue,
      selectedProbability,
      vendorConfidence,
      questionPlan,
      target,
      attribute,
      attrId,
      callId,
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
      permittedEvidence,
      catalogField,
    });
    if (eligibility.outcome === 'abstained') return eligibility.result;
    const groundedPacket = eligibility.groundedPacket;

    return {
      status: 'resolved',
      targetId: attrId,
      value: canonicalValue,
      confidence: selectedProbability,
      selectedProbability,
      vendorConfidence,
      probabilityBasis: 'choice_probability',
      source: 'jev',
      derivation: buildChoiceJudgmentDerivation(questionPlan.questionId, selectedProbability, vendorConfidence),
      modelCallIds: [callId],
      evidenceIds: groundedPacket.evidenceIds,
      supportingEvidenceIds: groundedPacket.supportingEvidenceIds,
      contradictingEvidenceIds: groundedPacket.contradictingEvidenceIds,
      hasConflict: groundedPacket.hasConflict,
    };    },
    fail: (err) =>
      failAttributeSingleDispatch({
        err,
        callId,
        startedAt,
        assertHeld,
        questionPlan,
        attrId,
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      }),
  });
}

async function executeAttributeSingleChoice(input: {
  target: ResolvedTarget;
  permittedEvidence: ClassificationEvidence[];
  sku: string;
  productContext: AttributeDecisionParams['productContext'];
  catalogField: string | null;
  attribute: ResolvedTarget['attribute'];
  attrId: string;
  route: ReturnType<typeof resolveModelRoute>;
  jevConn: any;
  ctx: ModelCallContext;
  effectivePolicy: ModelPolicyView;
  assertHeld?: () => void;
  runId: string;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): Promise<AttributeDecisionResult> {
  const {
    target,
    permittedEvidence,
    sku,
    productContext,
    catalogField,
    attribute,
    attrId,
    route,
    jevConn,
    ctx,
    effectivePolicy,
    assertHeld,
    runId,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  } = input;


  const prepared = prepareAttributeSingleChoice({
    target,
    permittedEvidence,
    sku,
    productContext,
    route,
    runId,
    ctx,
    effectivePolicy,
  });
  const { questionPlan, request, callId, startedAt } = prepared;

  return runAttributeSingleDispatch({
    jevConn,
    request,
    questionPlan,
    callId,
    assertHeld,
    startedAt,
    target,
    attribute,
    attrId,
    catalogField,
    permittedEvidence,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  });
}

/**
 * Parse brand evidence records to canonical brand names.
 */
/**
 * Resolve one brand evidence record to its canonical brand name (null when unresolvable).
 */
function resolveBrandRecordName(input: {
  record: ClassificationEvidence;
  attribute: ResolvedTarget['attribute'];
}): string | null {
  const { record, attribute } = input;
  const parsed = CanonicalBrandEvidenceValueSchema.safeParse(record.value);
  let name: unknown = parsed.success
    ? parsed.data.brandName
    : ((record.value as any)?.brandName ?? (record.value as any)?.name);
  if (typeof name !== 'string' && typeof record.value === 'string') {
    name = record.value;
  }
  return resolveCanonicalAssertion(name, attribute?.valueAliases ?? []);
}

function parseBrandEvidenceRecords(input: {
  brandEvidence: ClassificationEvidence[];
  attribute: ResolvedTarget['attribute'];
}): Array<{ id: string; brandName: string }> {
  const { brandEvidence, attribute } = input;
  const parsedBrands: Array<{ id: string; brandName: string }> = [];
  for (const record of brandEvidence) {
    const brandName = resolveBrandRecordName({ record, attribute });
    if (brandName !== null) {
      parsedBrands.push({ id: record.id, brandName });
    }
  }
  return parsedBrands;
}

/**
 * Resolve parsed brand names to a single option value. Null unless the
 * evidence is unanimous for one canonical brand.
 */
function resolveSingleBrandName(input: {
  parsedBrands: Array<{ id: string; brandName: string }>;
  options: ResolvedTargetOption[];
  attribute: ResolvedTarget['attribute'];
}): { value: string; allBrandIds: string[] } | null {
  const { parsedBrands, options, attribute } = input;
  if (parsedBrands.length === 0) return null;
  const uniqueBrands = [...new Set(parsedBrands.map(p => p.brandName))];
  if (uniqueBrands.length !== 1) return null;
  const brandName = uniqueBrands[0];
  const matchedOption = options.find(o =>
    resolveCanonicalAssertion(o.label, attribute?.valueAliases ?? []) === brandName,
  );
  const value = matchedOption?.label ?? brandName;
  const allBrandIds = parsedBrands.map(p => p.id).filter(Boolean);
  return { value, allBrandIds };
}

/**
 * Select brand-field evidence records eligible for the brand shortcut.
 */
function selectBrandEvidence(input: {
  permittedEvidence: ClassificationEvidence[];
  attrId: string;
}): ClassificationEvidence[] {
  const { permittedEvidence, attrId } = input;
  return permittedEvidence.filter(
    e =>
      e.sourceField === 'resolved_brand'
      || e.sourceField === 'brand'
      || e.attributeId === attrId
      || e.attributeId === 'brand',
  );
}

/**
 * Brand-shortcut precedence: a single canonical resolved brand resolves
 * brand attributes without model dispatch.
 */
function resolveAttributeBrandShortcut(input: {
  target: ResolvedTarget;
  cardinality: AttributeDecisionParams['cardinality'];
  permittedEvidence: ClassificationEvidence[];
  attribute: ResolvedTarget['attribute'];
  attrId: string;
  options: ResolvedTargetOption[];
}): AttributeDecisionResult | null {
  const {
    target,
    cardinality,
    permittedEvidence,
    attribute,
    attrId,
    options,
  } = input;
  // 3. Precedence: Brand shortcut
  const targetLabel = target.config.label.toLowerCase();
  const isBrandField = targetLabel.includes('brand') || attrId.toLowerCase().includes('brand');
  if (!isBrandField) return null;

  const brandEvidence = selectBrandEvidence({ permittedEvidence, attrId });
  if (brandEvidence.length === 0) return null;

  const parsedBrands = parseBrandEvidenceRecords({ brandEvidence, attribute });
  const resolved = resolveSingleBrandName({ parsedBrands, options, attribute });
  if (!resolved) return null;

  return {
    status: 'resolved',
    targetId: attrId,
    value: resolved.value,
    values: cardinality === 'multiple' ? [resolved.value] : undefined,
    confidence: 0.9,
    selectedProbability: null,
    vendorConfidence: null,
    probabilityBasis: 'brand_shortcut',
    source: 'brand_resolved',
    derivation: { kind: 'evidence_match' },
    modelCallIds: [],
    evidenceIds: resolved.allBrandIds,
    supportingEvidenceIds: resolved.allBrandIds,
    contradictingEvidenceIds: [],
  };
}

function checkAttributeDeterministicPrecedence(input: {
  target: ResolvedTarget;
  cardinality: AttributeDecisionParams['cardinality'];
  permittedEvidence: ClassificationEvidence[];
  packet: EvidenceTargetPacket;
  text: string;
  snapshot: RuntimeClassificationSnapshot | null | undefined;
  attribute: ResolvedTarget['attribute'];
  attrId: string;
  options: ResolvedTargetOption[];
}): AttributeDecisionResult | null {
  const {
    target,
    cardinality,
    permittedEvidence,
    packet,
    text,
    snapshot,
    attribute,
    attrId,
    options,
  } = input;
  const evidenceIds = packet.evidenceIds;
  const supportingEvidenceIds = packet.supportingEvidenceIds;
  const contradictingEvidenceIds = packet.contradictingEvidenceIds;
  const reviewedResult = resolveReviewedFactResult({ snapshot, target, cardinality, attrId, evidenceIds, supportingEvidenceIds, contradictingEvidenceIds });
  if (reviewedResult) return reviewedResult;
/**
 * Reviewed-fact precedence: an accepted field assignment resolves directly.
 */
function resolveReviewedFactResult(input: {
  snapshot: RuntimeClassificationSnapshot | null | undefined;
  target: ResolvedTarget;
  cardinality: AttributeDecisionParams['cardinality'];
  attrId: string;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): AttributeDecisionResult | null {
  const { snapshot, target, cardinality, attrId, evidenceIds, supportingEvidenceIds, contradictingEvidenceIds } = input;
  // 2. Precedence: Reviewed facts
  const reviewedFact = snapshot?.reviewedFacts?.find(
    f => f.proposalType === 'field_assignment' && (f.targetId === attrId || f.targetId === target.config.id),
  );
  if (!reviewedFact || reviewedFact.value === undefined || reviewedFact.value === null) return null;
    let values: string[] | undefined;
    let value: string;
    if (Array.isArray(reviewedFact.value)) {
      values = reviewedFact.value.map(String);
      value = values.join(', ');
    } else {
      value = String(reviewedFact.value);
      values = [value];
    }
    return {
      status: 'resolved',
      targetId: attrId,
      value,
      values: cardinality === 'multiple' ? values : undefined,
      confidence: 1.0,
      selectedProbability: null,
      vendorConfidence: null,
      probabilityBasis: 'reviewed_fact',
      source: 'keyword',
      derivation: { kind: 'evidence_match' },
      modelCallIds: [],
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    };
  return null;
}

  const brandShortcut = resolveAttributeBrandShortcut({ target, cardinality, permittedEvidence, attribute, attrId, options });
  if (brandShortcut) return brandShortcut;

/**
 * Deterministic alias/exact-match precedence over the evidence text.
 */
function resolveAttributeAliasMatch(input: {
  cardinality: AttributeDecisionParams['cardinality'];
  attribute: ResolvedTarget['attribute'];
  attrId: string;
  text: string;
  options: ResolvedTargetOption[];
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): AttributeDecisionResult | null {
  const {
    cardinality,
    attribute,
    attrId,
    text,
    options,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  } = input;
  // 4. Precedence: Deterministic alias/exact matches
  const optionStrings = options.map(o => o.label);
  const aliasMatches = attribute
    ? matchAttributeOptions(attribute, text, optionStrings, cardinality)
    : [];

  if (aliasMatches.length > 0) {
    if (cardinality === 'multiple') {
      const matchedVals = aliasMatches.map(m => m.value);
      return {
        status: 'resolved',
        targetId: attrId,
        value: matchedVals.join(', '),
        values: matchedVals,
        confidence: aliasMatches[0].confidence,
        selectedProbability: null,
        vendorConfidence: null,
        probabilityBasis: 'deterministic_alias',
        source: 'keyword',
        derivation: { kind: 'evidence_match' },
        modelCallIds: [],
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      };
    }
    const top = aliasMatches[0];
    return {
      status: 'resolved',
      targetId: attrId,
      value: top.value,
      confidence: top.confidence,
      selectedProbability: null,
      vendorConfidence: null,
      probabilityBasis: 'deterministic_alias',
      source: 'keyword',
      derivation: { kind: 'evidence_match' },
      modelCallIds: [],
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    };
  }

  return null;
}

  const aliasMatch = resolveAttributeAliasMatch({
    cardinality,
    attribute,
    attrId,
    text,
    options,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  });
  if (aliasMatch) return aliasMatch;

/**
 * Deterministic detail-enrichment precedence over the evidence text.
 */
function resolveAttributeEnrichmentMatch(input: {
  cardinality: AttributeDecisionParams['cardinality'];
  attribute: ResolvedTarget['attribute'];
  attrId: string;
  text: string;
  options: ResolvedTargetOption[];
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): AttributeDecisionResult | null {
  const {
    cardinality,
    attribute,
    attrId,
    text,
    options,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  } = input;
  // 4. Precedence: Deterministic detail enrichment
  const optionStrings = options.map(o => o.label);
  if (attribute) {
    const enrichmentParams = {
      evidenceText: text,
      packagingOcrData: null as any,
      curatedTitle: null,
      allowedValues: optionStrings,
      aliases: attribute.valueAliases ?? [],
    };
    const enrichmentCandidates = enrichProductDetails(enrichmentParams);
    const matching = enrichmentCandidates.filter(
      c => c.attributeId === attrId || c.attributeId === 'all',
    );
    if (matching.length > 0) {
      if (cardinality === 'multiple') {
        const enrichedVals = matching.map(m => m.value);
        return {
          status: 'resolved',
          targetId: attrId,
          value: enrichedVals.join(', '),
          values: enrichedVals,
          confidence: matching[0].confidence,
          selectedProbability: null,
          vendorConfidence: null,
          probabilityBasis: 'detail_enrichment',
          source: 'keyword',
          derivation: { kind: 'evidence_match' },
          modelCallIds: [],
          evidenceIds,
          supportingEvidenceIds,
          contradictingEvidenceIds,
        };
      }
      const top = matching[0];
      return {
        status: 'resolved',
        targetId: attrId,
        value: top.value,
        confidence: top.confidence,
        selectedProbability: null,
        vendorConfidence: null,
        probabilityBasis: 'detail_enrichment',
        source: 'keyword',
        derivation: { kind: 'evidence_match' },
        modelCallIds: [],
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      };
    }
  }

  return null;
}

  const enrichmentMatch = resolveAttributeEnrichmentMatch({
    cardinality,
    attribute,
    attrId,
    text,
    options,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  });
  if (enrichmentMatch) return enrichmentMatch;

  // 5. Check empty options
  if (options.length === 0) {
    return {
      status: 'abstained',
      targetId: attrId,
      value: null,
      confidence: 0,
      selectedProbability: null,
      vendorConfidence: null,
      probabilityBasis: null,
      source: 'keyword',
      abstentionCode: 'no_match',
      abstentionReason: `No attribute options configured in taxonomy for "${target.config.label}".`,
      derivation: { kind: 'evidence_match' },
      modelCallIds: [],
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    };
  }

  return null;
}

/**
 * Build the bounded target-specific evidence packet for one attribute decision.
 */
function buildAttributeDecisionPacket(input: {
  permittedEvidence: ClassificationEvidence[];
  attrId: string;
  catalogField: string | null;
  cardinality: AttributeDecisionParams['cardinality'];
  attribute: ResolvedTarget['attribute'];
}): EvidenceTargetPacket {
  const { permittedEvidence, attrId, catalogField, cardinality, attribute } = input;
  return buildEvidenceTargetPacket(permittedEvidence, {
    attributeId: attrId,
    sourceField: catalogField,
    selectionMode: cardinality,
    aliases: attribute?.valueAliases ?? [],
    isGroundingSupport: tokenGroundingSupport,
  });
}

/**
 * Resolve the effective frozen model policy view (null when absent or malformed).
 */
function resolveAttributeEffectivePolicy(
  modelPolicy: ModelPolicyView | null | undefined,
  snapshot: RuntimeClassificationSnapshot | null | undefined,
): ModelPolicyView | null {
  return asEffectivePolicyView(modelPolicy ?? snapshot?.modelPolicy ?? null);
}

/**
 * Build the terminal policy-denied result for single attributes.
 */
function buildAttributePolicyDeniedResult(input: {
  err: ModelPolicyDeniedError;
  runId: string;
  snapshot: RuntimeClassificationSnapshot | null | undefined;
  effectivePolicy: ModelPolicyView;
  assertHeld?: () => void;
  attrId: string;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): AttributeDecisionResult {
  const { err, runId, snapshot, effectivePolicy, assertHeld, attrId, evidenceIds, supportingEvidenceIds, contradictingEvidenceIds } = input;
  assertHeld?.();
  insertPolicyDeniedTerminalCall({
    runId,
    stageName: 'product_attribute_proposals',
    operation: 'attribute_ranking',
    provider: err.provider ?? null,
    snapshotHash: snapshot?.snapshotHash ?? '',
    modelPolicyDigest: effectivePolicy.policyDigest,
    promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS.attribute_ranking,
    ruleVersion: RULE_VERSIONS.attribute_ranking,
    errorMessage: err.message,
  });
  return {
    status: 'abstained',
    targetId: attrId,
    value: null,
    confidence: 0,
    selectedProbability: null,
    vendorConfidence: null,
    probabilityBasis: null,
    source: 'keyword',
    abstentionCode: 'policy_denied',
    abstentionReason: `Model policy denied: ${err.message}`,
    derivation: { kind: 'evidence_match' },
    modelCallIds: [],
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  };
}

// ─── Single Attribute Decision Resolution ─────────────────────────────────────

export async function resolveAttributeDecision(
  params: AttributeDecisionParams,
): Promise<AttributeDecisionResult> {
  const { target, cardinality, evidence, sku, runId, snapshot, modelPolicy, assertHeld, productContext } = params;
  assertHeld?.();
  const attrId = target.config.attributeId ?? target.config.id;
  const catalogField = target.config.catalogField ?? null;
  const attribute = target.attribute;
  const options = target.options;

  // Filter permitted evidence based on visualEvidenceEligibility
  const permittedEvidence = filterPermittedEvidence(evidence, attribute);

  // 1. Build bounded target-specific evidence packet
  const packet = buildAttributeDecisionPacket({ permittedEvidence, attrId, catalogField, cardinality, attribute });

  const text = packet.promptText;
  const evidenceIds = packet.evidenceIds;
  const supportingEvidenceIds = packet.supportingEvidenceIds;
  const contradictingEvidenceIds = packet.contradictingEvidenceIds;

  const deterministic = checkAttributeDeterministicPrecedence({
    target,
    cardinality,
    permittedEvidence,
    packet,
    text,
    snapshot,
    attribute,
    attrId,
    options,
  });
  if (deterministic) return deterministic;

  // 6. Resolve route through frozen model policy
  const effectivePolicy = resolveAttributeEffectivePolicy(modelPolicy, snapshot);

  let route: ReturnType<typeof resolveModelRoute> | null = null;
  let conn: any = null;
  let isSystemOne = false;

  if (effectivePolicy) {
    try {
      const decision = resolveDecisionRouteForOperation(effectivePolicy, 'attribute_ranking');
      route = decision.route;
      conn = decision.conn;
      isSystemOne = decision.isSystemOne;
    } catch (err) {
      if (err instanceof HeartbeatLostError) throw err;
      if (err instanceof ModelPolicyDeniedError) {
        return buildAttributePolicyDeniedResult({
          err,
          runId,
          snapshot,
          effectivePolicy,
          assertHeld,
          attrId,
          evidenceIds,
          supportingEvidenceIds,
          contradictingEvidenceIds,
        });
      }
      throw err;
    }
  }

  // 7. Legacy Chat LLM Fallback (OpenAI / Ollama / DeepSeek)
  if (!isSystemOne) {
    return executeAttributeLegacyFallback({
      target,
      cardinality,
      options,
      text,
      effectivePolicy,
      snapshot,
      runId,
      assertHeld,
      attrId,
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    });
  }

  // ── TypeSafe Jev System One Path ──────────────────────────────────────────
  const jevPreparation = prepareAttributeJevContext({
    cardinality,
    options,
    attrId,
    route,
    conn,
    effectivePolicy,
    snapshot,
    runId,
  });
  if (jevPreparation.outcome === 'limited') return jevPreparation.result;
  const { cleanAttrId, jevConn, ctx, route: jevRoute, effectivePolicy: jevPolicy } = jevPreparation;
type AttributeJevPreparation =
  | { outcome: 'limited'; result: AttributeDecisionResult }
  | {
      outcome: 'ready';
      cleanAttrId: string;
      jevConn: unknown;
      ctx: ModelCallContext;
      route: ReturnType<typeof resolveModelRoute>;
      effectivePolicy: ModelPolicyView;
    };

/**
 * Prepare one attribute Jev execution: candidate-limit guard, connection,
 * audit context, and plan compatibility.
 */
/**
 * Build the audit context for one attribute Jev execution and verify plan
 * compatibility.
 */
function buildAttributeJevContext(input: {
  runId: string;
  snapshot: RuntimeClassificationSnapshot | null | undefined;
}): ModelCallContext {
  const { runId, snapshot } = input;
  const ctx: ModelCallContext = {
    runId,
    snapshotHash: snapshot?.snapshotHash ?? '',
    stage: 'product_attribute_proposals',
    operation: 'attribute_ranking',
    attempt: 1,
    promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS.attribute_ranking,
    ruleVersion: RULE_VERSIONS.attribute_ranking,
  };

  if (snapshot) {
    assertModelPlanCompatible(snapshot, 'attribute_ranking', ctx);
  }

  return ctx;
}

/**
 * Resolve and verify the Jev connection for one attribute execution.
 */
function resolveAttributeJevConnection(input: {
  conn: any;
  route: ReturnType<typeof resolveModelRoute> | null;
  effectivePolicy: ModelPolicyView | null;
}): { jevConn: unknown; route: ReturnType<typeof resolveModelRoute>; effectivePolicy: ModelPolicyView } {
  const { conn, route, effectivePolicy } = input;
  if (!route || !effectivePolicy) {
    throw new Error('System One route or effective policy was not resolved.');
  }

  // Check connection usability and disablement
  const jevConn = conn ?? {
    id: route.provider,
    label: 'TypeSafe Jev',
    transport: 'systemone',
    baseUrl: route.baseUrl,
    trustZone: 'cloud',
    credential: route.apiKey,
    enabled: true,
  };

  assertConnectionEnabledForDispatch(jevConn as any, route.model || TYPESAFE_EVALUATED_MODEL);
  return { jevConn, route, effectivePolicy };
}

function prepareAttributeJevContext(input: {
  cardinality: AttributeDecisionParams['cardinality'];
  options: ResolvedTargetOption[];
  attrId: string;
  route: ReturnType<typeof resolveModelRoute> | null;
  conn: any;
  effectivePolicy: ModelPolicyView | null;
  snapshot: RuntimeClassificationSnapshot | null | undefined;
  runId: string;
}): AttributeJevPreparation {
  const {
    cardinality,
    options,
    attrId,
    route,
    conn,
    effectivePolicy,
    snapshot,
    runId,
  } = input;
  // Option limit check: > 253 produces explicit limit abstention (no clipping)
  const cleanAttrId = sanitizeQuestionIdSegment(attrId);
  if (options.length > MAX_ORDINARY_ATTRIBUTE_CANDIDATES) {
    return { outcome: 'limited', result: {
      status: 'abstained',
      targetId: attrId,
      value: null,
      values: undefined,
      confidence: 0,
      selectedProbability: null,
      vendorConfidence: null,
      probabilityBasis: cardinality === 'multiple' ? 'noul_probability' : 'choice_probability',
      source: 'jev',
      abstentionCode: 'candidate_limit_exceeded',
      abstentionReason: `candidate_limit_exceeded: Candidate attribute options (${options.length}) exceed maximum Choice capacity of ${MAX_ORDINARY_ATTRIBUTE_CANDIDATES}. First-N clipping is forbidden.`,
      derivation: {
        kind: 'systemone_judgment',
        primitive: cardinality === 'multiple' ? 'noul' : 'choice',
        questionId: cardinality === 'multiple' ? `attr_${cleanAttrId}` : `attr_${attrId}`,
        selectedProbability: null,
        vendorConfidence: null,
        probabilityBasis: cardinality === 'multiple' ? 'noul_probability' : 'choice_probability',
        abstentionCode: 'candidate_limit_exceeded',
      },
      modelCallIds: [],
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
      } };
  }

  const resolved = resolveAttributeJevConnection({ conn, route, effectivePolicy });

  const ctx = buildAttributeJevContext({ runId, snapshot });
  return { outcome: 'ready', cleanAttrId, jevConn: resolved.jevConn, ctx, route: resolved.route, effectivePolicy: resolved.effectivePolicy };
}

  // ── Multi-Value Jev Noul Dispatch ──────────────────────────────────────────
  if (cardinality === 'multiple') {
    return executeAttributeMultiValueNoul({
      target,
      permittedEvidence,
      sku,
      productContext,
      catalogField,
      attrId,
      cleanAttrId,
      route: jevRoute,
      jevConn,
      ctx,
      effectivePolicy: jevPolicy,
      assertHeld,
      runId,
      packet,
      constraints: params.constraints,
    });
  }

  // ── Single Choice Jev Path ────────────────────────────────────────────────
  return executeAttributeSingleChoice({
    target,
    permittedEvidence,
    sku,
    productContext,
    catalogField,
    attribute,
    attrId,
    route: jevRoute,
    jevConn,
    ctx,
    effectivePolicy: jevPolicy,
    assertHeld,
    runId,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  });
}

type PendingChoiceJevItem = {
  kind: 'choice';
  item: BatchAttributeDecisionItem;
  target: ResolvedTarget;
  attrId: string;
  cleanAttrId: string;
  catalogField: string | null;
  attribute?: ProductAttributeConfig;
  permittedEvidence: ClassificationEvidence[];
  packet: EvidenceTargetPacket;
  questionPlan: AttributeChoiceQuestionPlan;
  state: BoundedAttributeState;
  stateHash: string;
};

type PendingMultiJevItem = {
  kind: 'multiple';
  item: BatchAttributeDecisionItem;
  target: ResolvedTarget;
  attrId: string;
  cleanAttrId: string;
  catalogField: string | null;
  attribute?: ProductAttributeConfig;
  permittedEvidence: ClassificationEvidence[];
  packet: EvidenceTargetPacket;
  noulPlans: AttributeNoulQuestionPlan[];
  state: BoundedAttributeState;
  stateHash: string;
};

type PendingJevItem = PendingChoiceJevItem | PendingMultiJevItem;

type BatchStateQuestion =
  | {
      kind: 'choice';
      targetAttrId: string;
      questionId: string;
      payload: { type: 'choice'; instructions: string; criteria: Record<string, string> };
    }
  | {
      kind: 'noul';
      targetAttrId: string;
      questionId: string;
      plan: AttributeNoulQuestionPlan;
      payload: { type: 'noul'; instructions: string; criteria: { true: string; false: string } };
    };

type BatchItemTriage =
  | { outcome: 'resolved'; result: AttributeDecisionResult }
  | { outcome: 'pending'; pending: PendingJevItem };

/**
 * Triage one batch item: deterministic precedence first, then the candidate
 * limit and question/state preparation.
 */
function triageBatchAttributeItem(input: {
  item: BatchAttributeDecisionItem;
  evidence: ClassificationEvidence[];
  sku: string;
  productContext: AttributeDecisionParams['productContext'];
  snapshot: RuntimeClassificationSnapshot | null | undefined;
}): BatchItemTriage {
  const { item, evidence, sku, productContext, snapshot } = input;
    const { target, cardinality } = item;
    const attrId = target.config.attributeId ?? target.config.id;
    const catalogField = target.config.catalogField ?? null;
    const attribute = target.attribute;
    const options = target.options;

    // Filter permitted evidence based on visualEvidenceEligibility
    const permittedEvidence = filterPermittedEvidence(evidence, attribute);

    // Bounded target-specific packet
    const packet = buildEvidenceTargetPacket(permittedEvidence, {
      attributeId: attrId,
      sourceField: catalogField,
      selectionMode: cardinality,
      aliases: attribute?.valueAliases ?? [],
      isGroundingSupport: tokenGroundingSupport,
    });

    const text = packet.promptText;

    const deterministic = checkAttributeDeterministicPrecedence({
      target,
      cardinality,
      permittedEvidence,
      packet,
      text,
      snapshot,
      attribute,
      attrId,
      options,
    });
    if (deterministic) {
      return { outcome: 'resolved', result: deterministic };
    }

    const step = advanceBatchAttributePending({
      item,
      target,
      cardinality,
      options,
      attrId,
      catalogField,
      attribute,
      permittedEvidence,
      packet,
      sku,
      productContext,
    });
    if (step.action === 'abstained') return { outcome: 'resolved', result: step.result };
    return { outcome: 'pending', pending: step.pending };
}

// ─── Batch Attribute Decisions Resolution ─────────────────────────────────────

export interface BatchAttributeDecisionItem {
  target: ResolvedTarget;
  cardinality: 'single' | 'multiple';
  constraints?: {
    maxItems?: number;
    minItems?: number;
  };
}

export interface BatchAttributeDecisionParams {
  items: BatchAttributeDecisionItem[];
  evidence: ClassificationEvidence[];
  sku: string;
  runId: string;
  snapshot?: RuntimeClassificationSnapshot | null;
  modelPolicy?: ModelPolicyView | null;
  confidenceFloor?: number;
  assertHeld?: () => void;
  productContext?: {
    name?: string;
    brand?: string | null;
    productType?: string | null;
  };
}

/**
 * Resolves multiple attribute decisions, batching independent Jev questions
 * ONLY when their permitted state is identical.
 *
 * AC 7: "Batch independent questions only when their permitted state is identical;
 * never union restricted evidence across attributes for efficiency. Type-dependent
 * judgments run after the prerequisite type is available."
 */
type BatchPendingStep =
  | { action: 'abstained'; result: AttributeDecisionResult }
  | { action: 'pending'; pending: PendingJevItem };

/**
 * Enforce the batch candidate limit, then build the Jev question plan and
 * bounded state for one triaged item (batched only with identical states).
 */
function advanceBatchAttributePending(input: {
  item: BatchAttributeDecisionItem;
  target: ResolvedTarget;
  cardinality: AttributeDecisionParams['cardinality'];
  options: ResolvedTargetOption[];
  attrId: string;
  catalogField: string | null;
  attribute: ResolvedTarget['attribute'];
  permittedEvidence: ClassificationEvidence[];
  packet: EvidenceTargetPacket;
  sku: string;
  productContext: AttributeDecisionParams['productContext'];
}): BatchPendingStep {
  const {
    item,
    target,
    cardinality,
    options,
    attrId,
    catalogField,
    attribute,
    permittedEvidence,
    packet,
    sku,
    productContext,
  } = input;
    // 6. Option limit check
    const cleanAttrId = sanitizeQuestionIdSegment(attrId);
    if (options.length > MAX_ORDINARY_ATTRIBUTE_CANDIDATES) {
      return { action: 'abstained', result: {
        status: 'abstained',
        targetId: attrId,
        value: null,
        values: undefined,
        confidence: 0,
        selectedProbability: null,
        vendorConfidence: null,
        probabilityBasis: cardinality === 'multiple' ? 'noul_probability' : 'choice_probability',
        source: 'jev',
        abstentionCode: 'candidate_limit_exceeded',
        abstentionReason: `candidate_limit_exceeded: Candidate attribute options (${options.length}) exceed maximum Choice capacity of ${MAX_ORDINARY_ATTRIBUTE_CANDIDATES}. First-N clipping is forbidden.`,
        derivation: {
          kind: 'systemone_judgment',
          primitive: cardinality === 'multiple' ? 'noul' : 'choice',
          questionId: cardinality === 'multiple' ? `attr_${cleanAttrId}` : `attr_${attrId}`,
          selectedProbability: null,
          vendorConfidence: null,
          probabilityBasis: cardinality === 'multiple' ? 'noul_probability' : 'choice_probability',
          abstentionCode: 'candidate_limit_exceeded',
        },
        modelCallIds: [],
        evidenceIds: packet.evidenceIds,
        supportingEvidenceIds: packet.supportingEvidenceIds,
        contradictingEvidenceIds: packet.contradictingEvidenceIds,
      } };
    }

    // Build question plan and state
    const state = buildAttributeState(permittedEvidence, sku, productContext);
    const stateHash = hashCanonicalJson(state);

    if (cardinality === 'multiple') {
      const noulPlans = buildAttributeNoulQuestions(target, sku, productContext);
      return { action: 'pending', pending: {
        kind: 'multiple',
        item,
        target,
        attrId,
        cleanAttrId,
        catalogField,
        attribute,
        permittedEvidence,
        packet,
        noulPlans,
        state,
        stateHash,
      } };
    } else {
      const questionPlan = buildAttributeChoiceQuestion(target);
      return { action: 'pending', pending: {
        kind: 'choice',
        item,
        target,
        attrId,
        cleanAttrId,
        catalogField,
        attribute,
        permittedEvidence,
        packet,
        questionPlan,
        state,
        stateHash,
      } };
    }
}

/**
 * Batch legacy fallback: resolve each pending item through the singleton
 * attribute boundary (which applies its own chat-LLM path).
 */
async function resolveBatchLegacyFallbackItems(input: {
  pendingJevItems: PendingJevItem[];
  sku: string;
  runId: string;
  snapshot: RuntimeClassificationSnapshot | null | undefined;
  modelPolicy: ModelPolicyView | null;
  assertHeld?: () => void;
  productContext: AttributeDecisionParams['productContext'];
}): Promise<AttributeDecisionResult[]> {
  const { pendingJevItems, sku, runId, snapshot, modelPolicy, assertHeld, productContext } = input;
  const fallbackResults: AttributeDecisionResult[] = [];
    for (const p of pendingJevItems) {
      const singleRes = await resolveAttributeDecision({
        target: p.target,
        cardinality: p.item.cardinality,
        evidence: p.permittedEvidence,
        sku,
        runId,
        snapshot,
        modelPolicy,
        assertHeld,
        productContext,
        constraints: p.item.constraints,
      });
      fallbackResults.push(singleRes);
    }
  return fallbackResults;
}

/**
 * Dispatch one state group's batched Jev questions in chunks of at most 32,
 * collecting answers per question and errors per target (fail-closed).
 */
/**
 * Build one state group's flat question list plus <=32-question chunks.
 */
function buildBatchStateQuestions(group: PendingJevItem[]): {
  groupState: BoundedAttributeState;
  questionChunks: BatchStateQuestion[][];
} {
    const groupState = group[0].state;

const stateQuestions: BatchStateQuestion[] = [];
    for (const item of group) {
      if (item.kind === 'choice') {
        stateQuestions.push({
          kind: 'choice',
          targetAttrId: item.attrId,
          questionId: item.questionPlan.questionId,
          payload: {
            type: 'choice',
            instructions: item.questionPlan.instructions,
            criteria: item.questionPlan.criteria,
          },
        });
      } else {
        for (const plan of item.noulPlans) {
          stateQuestions.push({
            kind: 'noul',
            targetAttrId: item.attrId,
            questionId: plan.questionId,
            plan,
            payload: {
              type: 'noul',
              instructions: plan.instructions,
              criteria: plan.criteria,
            },
          });
        }
      }
    }

    // Chunk questions into chunks of at most 32 (SYSTEMONE_MAX_QUESTIONS)
    const questionChunks: BatchStateQuestion[][] = [];
    for (let i = 0; i < stateQuestions.length; i += SYSTEMONE_MAX_QUESTIONS) {
      questionChunks.push(stateQuestions.slice(i, i + SYSTEMONE_MAX_QUESTIONS));
    }
  return { groupState, questionChunks };
}

/**
 * Dispatch one batch chunk with audit rows, collecting answers and per-target
 * errors into the shared maps (mutated in place across chunks).
 */
/**
 * Prepare one batch chunk request: record assembly, hashing, the durable
 * audit start row, and touched-target collection.
 */
function prepareBatchAttributeChunk(input: {
  chunk: BatchStateQuestion[];
  groupState: BoundedAttributeState;
  route: ReturnType<typeof resolveModelRoute> | null;
  ctx: ModelCallContext;
  effectivePolicy: ModelPolicyView | null;
  assertHeld?: () => void;
  runId: string;
}): {
  questionsRecord: Record<string, any>;
  request: { model: string; state: BoundedAttributeState; questions: Record<string, any> };
  callId: string;
  touchedTargets: Set<string>;
} {
  const { chunk, groupState, route, ctx, effectivePolicy, assertHeld, runId } = input;
  const questionsRecord: Record<string, any> = {};
  for (const q of chunk) {
    questionsRecord[q.questionId] = q.payload;
  }

  const request = {
    model: route!.model || TYPESAFE_EVALUATED_MODEL,
    state: groupState,
    questions: questionsRecord,
  };

  assertHeld?.();
  const promptHash = hashCanonicalJson(request);

  const callId = openDecisionModelCall({
    runId,
    ctx,
    route,
    effectivePolicyDigest: effectivePolicy!.policyDigest,
    promptHash,
  });

  const touchedTargets = new Set(chunk.map(q => q.targetAttrId));
  return { questionsRecord, request, callId, touchedTargets };
}

/**
 * Collect one dispatched batch chunk's answers, recording per-target errors
 * for missing or mistyped answers (fail-closed per question).
 */
function collectBatchChunkAnswers(input: {
  chunk: BatchStateQuestion[];
  dispatchRes: { answers: Record<string, any> };
  allAnswers: Record<string, any>;
  targetErrors: Map<string, string>;
}): void {
  const { chunk, dispatchRes, allAnswers, targetErrors } = input;
  for (const q of chunk) {
    const ans = dispatchRes.answers[q.questionId];
    if (!ans || ans.type !== q.payload.type) {
      targetErrors.set(
        q.targetAttrId,
        `Missing or invalid answer for question "${q.questionId}" (expected ${q.payload.type}).`,
      );
    } else {
      allAnswers[q.questionId] = ans;
    }
  }
}

/**
 * Record one failed batch chunk dispatch and mark every touched target
 * failed (two-level atomicity per chunk).
 */
function failBatchAttributeChunk(input: {
  err: unknown;
  callId: string;
  startedAt: number;
  assertHeld?: () => void;
  touchedTargets: Set<string>;
  targetErrors: Map<string, string>;
}): void {
  const { err, callId, startedAt, assertHeld, touchedTargets, targetErrors } = input;
  if (err instanceof HeartbeatLostError) throw err;

  assertHeld?.();
  const durationMs = Date.now() - startedAt;
  completeModelCall(callId, {
    status: MODEL_CALL_STATUS.failed,
    endedAt: now(),
    durationMs,
    errorMessage: err instanceof Error ? err.message : String(err),
  });

  const errMessage = err instanceof Error ? err.message : String(err);
  for (const tId of touchedTargets) {
    targetErrors.set(tId, errMessage);
  }
}

async function runBatchAttributeChunk(input: {
  chunk: BatchStateQuestion[];
  groupState: BoundedAttributeState;
  route: ReturnType<typeof resolveModelRoute> | null;
  jevConn: any;
  ctx: ModelCallContext;
  effectivePolicy: ModelPolicyView | null;
  assertHeld?: () => void;
  runId: string;
  allAnswers: Record<string, any>;
  targetErrors: Map<string, string>;
  targetModelCallIds: Map<string, string[]>;
}): Promise<void> {
  const { chunk, groupState, route, jevConn, ctx, effectivePolicy, assertHeld, runId, allAnswers, targetErrors, targetModelCallIds } = input;
      const prepared = prepareBatchAttributeChunk({
        chunk,
        groupState,
        route,
        ctx,
        effectivePolicy,
        assertHeld,
        runId,
      });
      const { questionsRecord, request, callId, touchedTargets } = prepared;
      for (const tId of touchedTargets) {
        targetModelCallIds.get(tId)?.push(callId);
      }

      const startedAt = Date.now();
      try {
        assertHeld?.();
        const dispatchRes = await dispatchSystemOne(jevConn as any, request);
        assertHeld?.();

        assertSystemOneModelMatch(request.model, dispatchRes.returnedModel);

        const durationMs = Date.now() - startedAt;
        completeModelCall(callId, {
          status: MODEL_CALL_STATUS.success,
          endedAt: now(),
          durationMs,
          promptTokens: dispatchRes.usage.inputTokens,
          completionTokens: dispatchRes.usage.outputTokens,
          resolvedModel: dispatchRes.returnedModel,
          typedResultMetadata: {
            batchedQuestions: Object.keys(questionsRecord),
            resolvedModel: dispatchRes.returnedModel,
          },
        });

        collectBatchChunkAnswers({ chunk, dispatchRes, allAnswers, targetErrors });
      } catch (err) {
        failBatchAttributeChunk({
          err,
          callId,
          startedAt,
          assertHeld,
          touchedTargets,
          targetErrors,
        });
      }
}

async function dispatchBatchAttributeGroup(input: {
  group: PendingJevItem[];
  route: ReturnType<typeof resolveModelRoute> | null;
  jevConn: any;
  ctx: ModelCallContext;
  effectivePolicy: ModelPolicyView | null;
  assertHeld?: () => void;
  runId: string;
}): Promise<{
  allAnswers: Record<string, any>;
  targetErrors: Map<string, string>;
  targetModelCallIds: Map<string, string[]>;
}> {
  const { group, route, jevConn, ctx, effectivePolicy, assertHeld, runId } = input;
  const { groupState, questionChunks } = buildBatchStateQuestions(group);
  const allAnswers: Record<string, any> = {};
  const targetErrors = new Map<string, string>();
  const targetModelCallIds = new Map<string, string[]>();

  for (const item of group) {
    targetModelCallIds.set(item.attrId, []);
  }

    for (const chunk of questionChunks) {
      await runBatchAttributeChunk({
        chunk,
        groupState,
        route,
        jevConn,
        ctx,
        effectivePolicy,
        assertHeld,
        runId,
        allAnswers,
        targetErrors,
        targetModelCallIds,
      });
    }
  return { allAnswers, targetErrors, targetModelCallIds };
}

/**
 * Fail-closed result for a batch item whose questions errored or went
 * unanswered during grouped dispatch.
 */
function buildBatchItemErrorResult(
  item: PendingJevItem,
  callIds: string[],
  errorMsg: string,
): AttributeDecisionResult {
  return {
          status: 'failed',
          targetId: item.attrId,
          value: null,
          values: undefined,
          confidence: 0,
          selectedProbability: null,
          vendorConfidence: null,
          probabilityBasis: null,
          source: 'jev',
          abstentionCode: 'service_failure',
          abstentionReason: `service_failure: ${item.kind === 'multiple' ? 'Incomplete candidate batch: ' : ''}${errorMsg}`,
          derivation: {
            kind: 'systemone_judgment',
            primitive: item.kind === 'multiple' ? 'noul' : 'choice',
            questionId: item.kind === 'multiple' ? `attr_${item.cleanAttrId}` : item.questionPlan.questionId,
            selectedProbability: null,
            vendorConfidence: null,
            probabilityBasis: item.kind === 'multiple' ? 'noul_probability' : 'choice_probability',
            abstentionCode: 'service_failure',
          },
          modelCallIds: callIds,
          evidenceIds: item.packet.evidenceIds,
          supportingEvidenceIds: item.packet.supportingEvidenceIds,
          contradictingEvidenceIds: item.packet.contradictingEvidenceIds,
        };
}

/**
 * Interpret one batch choice answer: missing-answer failure, abstention
 * outcomes, canonical mapping, the 0.50 floor, regrounding, the
 * claims/composition safeguard, then resolution.
 */
type BatchChoiceEarlyOutcome =
  | { abstained: AttributeDecisionResult }
  | { choiceKey: string; selectedProbability: number; vendorConfidence: number };

function interpretBatchChoiceEarlyAbstention(
  item: PendingChoiceJevItem,
  allAnswers: Record<string, any>,
  callIds: string[],
): BatchChoiceEarlyOutcome {

  const answer = allAnswers[item.questionPlan.questionId];
        if (!answer || answer.type !== 'choice') {
          return { abstained: {
            status: 'failed',
            targetId: item.attrId,
            value: null,
            confidence: 0,
            selectedProbability: null,
            vendorConfidence: null,
            probabilityBasis: 'choice_probability',
            source: 'jev',
            abstentionCode: 'service_failure',
            abstentionReason: `Expected choice answer for question "${item.questionPlan.questionId}", got "${answer?.type ?? 'missing'}".`,
            derivation: buildChoiceJudgmentDerivation(item.questionPlan.questionId, null, null, 'service_failure'),
            modelCallIds: callIds,
            evidenceIds: item.packet.evidenceIds,
            supportingEvidenceIds: item.packet.supportingEvidenceIds,
            contradictingEvidenceIds: item.packet.contradictingEvidenceIds,
          } };
        }

        const choiceKey = answer.choice;
        const selectedProbability = answer.probabilities[choiceKey] ?? 0;
        const vendorConfidence = answer.confidence;

        if (choiceKey === NO_MATCH_CHOICE_KEY) {
          return { abstained: {
            status: 'abstained',
            targetId: item.attrId,
            value: null,
            confidence: 0,
            selectedProbability,
            vendorConfidence,
            probabilityBasis: 'choice_probability',
            source: 'jev',
            abstentionCode: 'no_match',
            abstentionReason: `no_fit: No matching option in the configured taxonomy applies to this product for "${item.target.config.label}".`,
            derivation: buildChoiceJudgmentDerivation(item.questionPlan.questionId, selectedProbability, vendorConfidence, 'no_match'),
            modelCallIds: callIds,
            evidenceIds: item.packet.evidenceIds,
            supportingEvidenceIds: item.packet.supportingEvidenceIds,
            contradictingEvidenceIds: item.packet.contradictingEvidenceIds,
          } };
        }

        if (choiceKey === INSUFFICIENT_EVIDENCE_CHOICE_KEY) {
          return { abstained: {
            status: 'abstained',
            targetId: item.attrId,
            value: null,
            confidence: 0,
            selectedProbability,
            vendorConfidence,
            probabilityBasis: 'choice_probability',
            source: 'jev',
            abstentionCode: 'insufficient_evidence',
            abstentionReason: `insufficient_evidence: Product evidence is insufficient to determine "${item.target.config.label}" with confidence.`,
            derivation: buildChoiceJudgmentDerivation(item.questionPlan.questionId, selectedProbability, vendorConfidence, 'insufficient_evidence'),
            modelCallIds: callIds,
            evidenceIds: item.packet.evidenceIds,
            supportingEvidenceIds: item.packet.supportingEvidenceIds,
            contradictingEvidenceIds: item.packet.contradictingEvidenceIds,
          } };
        }

  return { choiceKey, selectedProbability, vendorConfidence };
}

/**
 * Resolve one mapped batch choice: regrounding, the claims/composition
 * safeguard, then the resolved value.
 */
function resolveBatchChoiceSelection(input: {
  item: PendingChoiceJevItem;
  canonicalValue: string;
  selectedProbability: number;
  vendorConfidence: number;
  callIds: string[];
}): AttributeDecisionResult {
  const { item, canonicalValue, selectedProbability, vendorConfidence, callIds } = input;
    // Reground
        const groundedPacket = buildEvidenceTargetPacket(item.permittedEvidence, {
          attributeId: item.attrId,
          sourceField: item.catalogField,
          selectionMode: 'single',
          proposedValue: canonicalValue,
          aliases: item.attribute?.valueAliases ?? [],
          isGroundingSupport: tokenGroundingSupport,
        });

        // Claims / composition safeguard
        if (item.attribute?.isClaim === true || item.attribute?.isCompositionAttribute === true) {
          const hasDirectSupporting = groundedPacket.supporting.some(
            e => DIRECT_EVIDENCE_SOURCES.has(e.source),
          );
          if (!hasDirectSupporting) {
            return {
              status: 'abstained',
              targetId: item.attrId,
              value: null,
              confidence: 0,
              selectedProbability,
              vendorConfidence,
              probabilityBasis: 'choice_probability',
              source: 'jev',
              abstentionCode: 'unsupported_claim',
              abstentionReason: `unsupported_claim: "${item.target.config.label}" requires target-specific direct product evidence, but none was found. A high probability cannot authorize an unsupported claim or infer a claim from absence.`,
              derivation: buildChoiceJudgmentDerivation(item.questionPlan.questionId, selectedProbability, vendorConfidence, 'unsupported_claim'),
              modelCallIds: callIds,
              evidenceIds: groundedPacket.evidenceIds,
              supportingEvidenceIds: groundedPacket.supportingEvidenceIds,
              contradictingEvidenceIds: groundedPacket.contradictingEvidenceIds,
            };
          }
        }

        return {
          status: 'resolved',
          targetId: item.attrId,
          value: canonicalValue,
          confidence: selectedProbability,
          selectedProbability,
          vendorConfidence,
          probabilityBasis: 'choice_probability',
          source: 'jev',
          derivation: buildChoiceJudgmentDerivation(item.questionPlan.questionId, selectedProbability, vendorConfidence),
          modelCallIds: callIds,
          evidenceIds: groundedPacket.evidenceIds,
          supportingEvidenceIds: groundedPacket.supportingEvidenceIds,
          contradictingEvidenceIds: groundedPacket.contradictingEvidenceIds,
          hasConflict: groundedPacket.hasConflict,
        };}

function interpretBatchChoiceItemResult(
  item: PendingChoiceJevItem,
  allAnswers: Record<string, any>,
  callIds: string[],
): AttributeDecisionResult {
  const early = interpretBatchChoiceEarlyAbstention(item, allAnswers, callIds);
  if ('abstained' in early) return early.abstained;
  const { choiceKey, selectedProbability, vendorConfidence } = early;
        const canonicalValue = item.questionPlan.keyToIdMap.get(choiceKey);
        if (!canonicalValue) {
          return {
            status: 'failed',
            targetId: item.attrId,
            value: null,
            confidence: 0,
            selectedProbability,
            vendorConfidence,
            probabilityBasis: 'choice_probability',
            source: 'jev',
            abstentionCode: 'service_failure',
            abstentionReason: `Returned choice key "${choiceKey}" does not map to any canonical option value.`,
            derivation: buildChoiceJudgmentDerivation(item.questionPlan.questionId, selectedProbability, vendorConfidence, 'service_failure'),
            modelCallIds: callIds,
            evidenceIds: item.packet.evidenceIds,
            supportingEvidenceIds: item.packet.supportingEvidenceIds,
            contradictingEvidenceIds: item.packet.contradictingEvidenceIds,
          };
        }

        if (selectedProbability < JEV_ATTRIBUTE_MIN_PROBABILITY) {
          return {
            status: 'abstained',
            targetId: item.attrId,
            value: null,
            confidence: 0,
            selectedProbability,
            vendorConfidence,
            probabilityBasis: 'choice_probability',
            source: 'jev',
            abstentionCode: 'low_probability',
            abstentionReason: `low_probability: Selected attribute value "${canonicalValue}" probability (${selectedProbability.toFixed(3)}) is below required threshold (${JEV_ATTRIBUTE_MIN_PROBABILITY}).`,
            derivation: buildChoiceJudgmentDerivation(item.questionPlan.questionId, selectedProbability, vendorConfidence, 'low_probability'),
            modelCallIds: callIds,
            evidenceIds: item.packet.evidenceIds,
            supportingEvidenceIds: item.packet.supportingEvidenceIds,
            contradictingEvidenceIds: item.packet.contradictingEvidenceIds,
          };
        }

        return resolveBatchChoiceSelection({
      item,
      canonicalValue,
      selectedProbability,
      vendorConfidence,
      callIds,
    });

}

/**
 * Interpret one batch multi-value item: fail-closed answer collection, then
 * the frozen multi-value selection policy.
 */
function interpretBatchMultiItemResult(
  item: PendingMultiJevItem,
  allAnswers: Record<string, any>,
  callIds: string[],
): AttributeDecisionResult {
        // Multi-value item
        const candidates: MultiValueCandidateEvaluation[] = [];
        let anyMissing = false;

        for (const plan of item.noulPlans) {
          const ans = allAnswers[plan.questionId];
          if (!ans || ans.type !== 'noul') {
            anyMissing = true;
            break;
          }
          candidates.push({
            optionValue: plan.optionValue,
            optionLabel: plan.optionLabel,
            optionIndex: plan.optionIndex,
            prob: ans.noul,
          });
        }

        if (anyMissing) {
          return {
            status: 'failed',
            targetId: item.attrId,
            value: null,
            values: undefined,
            confidence: 0,
            selectedProbability: null,
            vendorConfidence: null,
            probabilityBasis: null,
            source: 'jev',
            abstentionCode: 'service_failure',
            abstentionReason: `service_failure: Incomplete candidate batch: not all candidate questions received answers from provider.`,
            derivation: buildNoulJudgmentDerivation(`attr_${item.cleanAttrId}`, null, { abstentionCode: 'service_failure' }),
            modelCallIds: callIds,
            evidenceIds: item.packet.evidenceIds,
            supportingEvidenceIds: item.packet.supportingEvidenceIds,
            contradictingEvidenceIds: item.packet.contradictingEvidenceIds,
          };
        }

        const policyOutcome = evaluateMultiValueSelectionPolicy({
          target: item.target,
          candidates,
          permittedEvidence: item.permittedEvidence,
          catalogField: item.catalogField,
          maxItems: item.item.constraints?.maxItems,
          minItems: item.item.constraints?.minItems,
        });

        if (policyOutcome.outcome === 'abstained') {
          return {
            status: 'abstained',
            targetId: item.attrId,
            value: null,
            values: undefined,
            confidence: 0,
            selectedProbability: policyOutcome.topProb,
            vendorConfidence: null,
            probabilityBasis: 'noul_probability',
            candidateProbabilities: policyOutcome.candidateProbabilities,
            source: 'jev',
            abstentionCode: policyOutcome.abstentionCode,
            abstentionReason: policyOutcome.abstentionReason,
            derivation: buildNoulJudgmentDerivation(`attr_${item.cleanAttrId}`, policyOutcome.topProb, { abstentionCode: policyOutcome.abstentionCode, candidateProbabilities: policyOutcome.candidateProbabilities }),
            modelCallIds: callIds,
            evidenceIds: policyOutcome.groundedPacket.evidenceIds,
            supportingEvidenceIds: policyOutcome.groundedPacket.supportingEvidenceIds,
            contradictingEvidenceIds: policyOutcome.groundedPacket.contradictingEvidenceIds,
          };
        } else {
          return {
            status: 'resolved',
            targetId: item.attrId,
            value: policyOutcome.selectedValues.join(', '),
            values: policyOutcome.selectedValues,
            confidence: policyOutcome.topProb,
            selectedProbability: policyOutcome.topProb,
            vendorConfidence: null,
            probabilityBasis: 'noul_probability',
            candidateProbabilities: policyOutcome.candidateProbabilities,
            source: 'jev',
            derivation: buildNoulJudgmentDerivation(`attr_${item.cleanAttrId}`, policyOutcome.topProb, { candidateProbabilities: policyOutcome.candidateProbabilities }),
            modelCallIds: callIds,
            evidenceIds: policyOutcome.groundedPacket.evidenceIds,
            supportingEvidenceIds: policyOutcome.groundedPacket.supportingEvidenceIds,
            contradictingEvidenceIds: policyOutcome.groundedPacket.contradictingEvidenceIds,
            hasConflict: policyOutcome.groundedPacket.hasConflict,
          };
        }
}

/**
 * Build terminal policy-denied results for every pending batch item.
 */
function buildBatchPolicyDeniedResults(input: {
  err: ModelPolicyDeniedError;
  runId: string;
  snapshot: RuntimeClassificationSnapshot | null | undefined;
  effectivePolicy: ModelPolicyView;
  assertHeld?: () => void;
  pendingJevItems: PendingJevItem[];
}): AttributeDecisionResult[] {
  const { err, runId, snapshot, effectivePolicy, assertHeld, pendingJevItems } = input;
  assertHeld?.();
  insertPolicyDeniedTerminalCall({
    runId,
    stageName: 'product_attribute_proposals',
    operation: 'attribute_ranking',
    provider: err.provider ?? null,
    snapshotHash: snapshot?.snapshotHash ?? '',
    modelPolicyDigest: effectivePolicy.policyDigest,
    promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS.attribute_ranking,
    ruleVersion: RULE_VERSIONS.attribute_ranking,
    errorMessage: err.message,
  });
  const denied: AttributeDecisionResult[] = [];
  for (const item of pendingJevItems) {
    denied.push({
      status: 'abstained',
      targetId: item.attrId,
      value: null,
      confidence: 0,
      selectedProbability: null,
      vendorConfidence: null,
      probabilityBasis: null,
      source: 'keyword',
      abstentionCode: 'policy_denied',
      abstentionReason: `Model policy denied: ${err.message}`,
      derivation: { kind: 'evidence_match' },
      modelCallIds: [],
      evidenceIds: item.packet.evidenceIds,
      supportingEvidenceIds: item.packet.supportingEvidenceIds,
      contradictingEvidenceIds: item.packet.contradictingEvidenceIds,
    });
  }
  return denied;
}

/**
 * Group pending Jev items by identical state hash for batched dispatch.
 */
function groupBatchItemsByState(pendingJevItems: PendingJevItem[]): Map<string, PendingJevItem[]> {
  const groupsByState = new Map<string, PendingJevItem[]>();
  for (const item of pendingJevItems) {
    const list = groupsByState.get(item.stateHash);
    if (list) list.push(item);
    else groupsByState.set(item.stateHash, [item]);
  }
  return groupsByState;
}

/**
 * Prepare the shared batch Jev context: connection fallback, audit context,
 * and plan compatibility.
 */
function prepareBatchJevContext(input: {
  conn: any;
  route: ReturnType<typeof resolveModelRoute> | null;
  runId: string;
  snapshot: RuntimeClassificationSnapshot | null | undefined;
}): { jevConn: unknown; ctx: ModelCallContext } {
  const { conn, route, runId, snapshot } = input;
  const jevConn = conn ?? {
    id: route!.provider,
    label: 'TypeSafe Jev',
    transport: 'systemone',
    baseUrl: route!.baseUrl,
    trustZone: 'cloud',
    credential: route!.apiKey,
    enabled: true,
  };

  assertConnectionEnabledForDispatch(jevConn as any, route!.model || TYPESAFE_EVALUATED_MODEL);

  const ctx: ModelCallContext = {
    runId,
    snapshotHash: snapshot?.snapshotHash ?? '',
    stage: 'product_attribute_proposals',
    operation: 'attribute_ranking',
    attempt: 1,
    promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS.attribute_ranking,
    ruleVersion: RULE_VERSIONS.attribute_ranking,
  };

  if (snapshot) {
    assertModelPlanCompatible(snapshot, 'attribute_ranking', ctx);
  }

  return { jevConn, ctx };
}

async function processBatchAttributeGroup(input: {
  group: PendingJevItem[];
  route: ReturnType<typeof resolveModelRoute> | null;
  jevConn: any;
  ctx: ModelCallContext;
  effectivePolicy: ModelPolicyView | null;
  assertHeld?: () => void;
  runId: string;
  results: AttributeDecisionResult[];
}): Promise<void> {
  const { group, route, jevConn, ctx, effectivePolicy, assertHeld, runId, results } = input;
    const { allAnswers, targetErrors, targetModelCallIds } = await dispatchBatchAttributeGroup({
      group,
      route,
      jevConn,
      ctx,
      effectivePolicy,
      assertHeld,
      runId,
    });

    // Now process answers for each item in the group
    for (const item of group) {
      const callIds = targetModelCallIds.get(item.attrId) ?? [];
      const errorMsg = targetErrors.get(item.attrId);

      if (errorMsg) {
        results.push(buildBatchItemErrorResult(item, callIds, errorMsg));
        continue;
      }

      if (item.kind === 'choice') {
        results.push(interpretBatchChoiceItemResult(item, allAnswers, callIds));
      } else {
        results.push(interpretBatchMultiItemResult(item, allAnswers, callIds));
      }
    }
}

/**
 * Process every state group in turn, appending each member result to the
 * shared results list (mutated in place, group order preserved).
 */
async function processAllBatchAttributeGroups(input: {
  groupsByState: Map<string, PendingJevItem[]>;
  route: ReturnType<typeof resolveModelRoute> | null;
  jevConn: any;
  ctx: ModelCallContext;
  effectivePolicy: ModelPolicyView | null;
  assertHeld?: () => void;
  runId: string;
  results: AttributeDecisionResult[];
}): Promise<void> {
  const { groupsByState, route, jevConn, ctx, effectivePolicy, assertHeld, runId, results } = input;
  // Process each state group: identical state items are batched into requests of <= 32 questions
  for (const [, group] of groupsByState) {
    await processBatchAttributeGroup({
      group,
      route,
      jevConn,
      ctx,
      effectivePolicy,
      assertHeld,
      runId,
      results,
    });
  }
}

/**
 * Triage every batch item into immediately-resolved results vs Jev-pending
 * items, preserving input order in each list.
 */
function triageAllBatchAttributeItems(input: {
  items: BatchAttributeDecisionItem[];
  evidence: ClassificationEvidence[];
  sku: string;
  productContext: AttributeDecisionParams['productContext'];
  snapshot: RuntimeClassificationSnapshot | null | undefined;
}): { resolved: AttributeDecisionResult[]; pending: PendingJevItem[] } {
  const { items, evidence, sku, productContext, snapshot } = input;
  const resolved: AttributeDecisionResult[] = [];
  const pending: PendingJevItem[] = [];
  for (const item of items) {
    const triaged = triageBatchAttributeItem({ item, evidence, sku, productContext, snapshot });
    if (triaged.outcome === 'resolved') resolved.push(triaged.result);
    else pending.push(triaged.pending);
  }
  return { resolved, pending };
}

export async function batchResolveAttributeDecisions(
  params: BatchAttributeDecisionParams,
): Promise<AttributeDecisionResult[]> {
  const { items, evidence, sku, runId, snapshot, modelPolicy, assertHeld, productContext } = params;
  const results: AttributeDecisionResult[] = [];

  // Group items that need Jev resolution vs deterministic / unsupported



  const pendingJevItems: PendingJevItem[] = [];

  const triaged = triageAllBatchAttributeItems({ items, evidence, sku, productContext, snapshot });
  results.push(...triaged.resolved);
  pendingJevItems.push(...triaged.pending);

  if (pendingJevItems.length === 0) {
    return results;
  }

  // Resolve route through frozen model policy
  const effectivePolicy = resolveAttributeEffectivePolicy(modelPolicy, snapshot);

  let route: ReturnType<typeof resolveModelRoute> | null = null;
  let conn: any = null;
  let isSystemOne = false;

  if (effectivePolicy) {
    try {
      const decision = resolveDecisionRouteForOperation(effectivePolicy, 'attribute_ranking');
      route = decision.route;
      conn = decision.conn;
      isSystemOne = decision.isSystemOne;
    } catch (err) {
      if (err instanceof HeartbeatLostError) throw err;
      if (err instanceof ModelPolicyDeniedError) {
        results.push(...buildBatchPolicyDeniedResults({
          err,
          runId,
          snapshot,
          effectivePolicy,
          assertHeld,
          pendingJevItems,
        }));
        return results;
      }
      throw err;
    }
  }

  // If not SystemOne, fall back to individual chat LLM calls
  if (!isSystemOne) {
    results.push(...(await resolveBatchLegacyFallbackItems({
      pendingJevItems,
      sku,
      runId,
      snapshot,
      modelPolicy: modelPolicy ?? null,
      assertHeld,
      productContext,
    })));
    return results;
  }

  // Group pending Jev items by identical stateHash
  const groupsByState = groupBatchItemsByState(pendingJevItems);

  const { jevConn, ctx } = prepareBatchJevContext({ conn, route, runId, snapshot });

/**
 * Process one state group: dispatch its batched questions, then interpret
 * every member answer into the shared results list (mutated in place).
 */

  await processAllBatchAttributeGroups({
    groupsByState,
    route,
    jevConn,
    ctx,
    effectivePolicy,
    assertHeld,
    runId,
    results,
  });

  return results;
}

// ─── Build Proposal from Decision Result ──────────────────────────────────────

export function buildProposalFromAttributeDecision(
  decision: AttributeDecisionResult,
  sku: string,
  runId: string,
  snapshotHash?: string | null,
): ClassificationProposal {
  if (hasResolvedAttributeValue(decision)) {
    return buildResolvedAttributeProposal({ decision, sku, runId, snapshotHash });
  }

/**
 * True when an attribute decision resolved to a usable value.
 */
function hasResolvedAttributeValue(decision: AttributeDecisionResult): boolean {
  return decision.status === 'resolved'
    && Boolean(decision.value !== null || (decision.values && decision.values.length > 0));
}

/**
 * Build the field-assignment proposal for a resolved attribute decision.
 */
function buildResolvedAttributeProposal(input: {
  decision: AttributeDecisionResult;
  sku: string;
  runId: string;
  snapshotHash?: string | null;
}): ClassificationProposal {
  const { decision, sku, runId, snapshotHash } = input;
    const isMultiple = Boolean(decision.values && decision.values.length > 0);
    const proposalValue = isMultiple ? decision.values! : decision.value!;
    return buildFieldAssignmentProposal({
      runId,
      sku,
      attributeId: decision.targetId,
      value: proposalValue,
      confidence: decision.confidence,
      evidenceIds: decision.evidenceIds,
      supportingEvidenceIds: decision.supportingEvidenceIds,
      contradictingEvidenceIds: decision.contradictingEvidenceIds,
      isMultiple,
      isBulkAcceptable: decision.source === 'jev' ? false : (decision.hasConflict ? false : undefined),
      snapshotHash,
      modelCallIds: decision.modelCallIds,
      derivation: decision.derivation,
    });
}

  // Explicit reviewable abstention
  return {
    id: randomUUID(),
    runId,
    productSku: sku,
    proposalType: 'reviewable_abstention',
    targetId: decision.targetId,
    proposedValue: {
      reason: decision.abstentionReason ?? 'Attribute value could not be resolved.',
      code: decision.abstentionCode ?? 'unresolved',
      attributeId: decision.targetId,
      selectedProbability: decision.selectedProbability,
      vendorConfidence: decision.vendorConfidence,
      ...(decision.candidateProbabilities ? { candidateProbabilities: decision.candidateProbabilities } : {}),
    },
    confidence: 0,
    evidenceIds: decision.evidenceIds,
    supportingEvidenceIds: decision.supportingEvidenceIds,
    contradictingEvidenceIds: decision.contradictingEvidenceIds,
    derivation: decision.derivation,
    status: 'pending',
    isBulkAcceptable: false,
    isStale: false,
    stalenessReason: null,
    snapshotHash: snapshotHash ?? null,
    modelCallIds: decision.modelCallIds,
    createdAt: now(),
  };
}
