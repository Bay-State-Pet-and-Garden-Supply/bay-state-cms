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
  isSystemOneModelMatch,
  SYSTEMONE_MAX_CHOICE_OPTIONS,
  SYSTEMONE_MAX_ABSTENTION_RESERVED,
  SYSTEMONE_MAX_QUESTIONS,
  SYSTEMONE_MAX_STATE_BYTES,
  TYPESAFE_EVALUATED_MODEL,
} from '../ai/systemone-transport';
import {
  assertConnectionEnabledForDispatch,
} from '../ai/provider-connections';
import { getFullAiRoutingConfig } from '../db/repositories/provider-connection-repo';
import { getApiKey } from '../db/repositories/api-key-repo';
import {
  insertModelCallStart,
  completeModelCall,
  insertTerminalModelCall,
} from '../db/repositories/classification-model-call-repo';
import {
  MODEL_CALL_STATUS,
  COST_BASIS,
  PROMPT_TEMPLATE_VERSIONS,
  RULE_VERSIONS,
  type ModelCallContext,
} from './model-operation-registry';
import {
  resolveModelRoute,
  assertModelPolicyIntact,
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
import { buildFieldAssignmentProposal } from './curation-target-proposal';

// ─── Versioned Constants ──────────────────────────────────────────────────────

export const ATTRIBUTE_JUDGMENT_VERSION = 'jev-choice-v1';
export const ATTRIBUTE_NOUL_JUDGMENT_VERSION = 'jev-noul-v1';
export const ATTRIBUTE_QUESTION_VERSION = 'attribute-question-v1';
export const ATTRIBUTE_ELIGIBILITY_VERSION = 'jev-attr-eligibility-v1';
export const ATTRIBUTE_STATE_VERSION = 'attribute-state-v1';

export const MAX_ORDINARY_ATTRIBUTE_CANDIDATES =
  SYSTEMONE_MAX_CHOICE_OPTIONS - SYSTEMONE_MAX_ABSTENTION_RESERVED; // 253

export const NO_MATCH_CHOICE_KEY = 'no_match';
export const INSUFFICIENT_EVIDENCE_CHOICE_KEY = 'insufficient_evidence';

/**
 * Development-fitted minimum probability for Jev Choice attribute selection.
 * An ungrounded option pick below 0.50 probability is an explicit semantic abstention.
 */
export const JEV_ATTRIBUTE_MIN_PROBABILITY = 0.50;

/**
 * Development-fitted minimum probability for Jev Noul multi-value attribute selection.
 * For independent binary judgments, P(yes) >= 0.70 demonstrates explicit positive support.
 */
export const JEV_MULTI_VALUE_MIN_PROBABILITY = 0.70;

/**
 * Floor below which all candidate probabilities indicate no fitting options in taxonomy.
 */
export const JEV_MULTI_VALUE_UNCERTAIN_FLOOR = 0.40;

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

export interface BoundedAttributeState {
  sku: string;
  name: string;
  brand: string | null;
  productType: string | null;
  evidenceCount: number;
  evidenceText: string;
  snippets: string[];
}

/**
 * Filter evidence according to attribute eligibility.
 * E.g., if visualEvidenceEligibility is 'ineligible', exclude visual_product_evidence.
 */
export function filterPermittedEvidence(
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
export function buildAttributeState(
  evidence: ClassificationEvidence[],
  sku: string,
  productContext?: { name?: string; brand?: string | null; productType?: string | null },
): BoundedAttributeState {
  let name = productContext?.name || '';
  let brand = productContext?.brand ?? null;
  let productType = productContext?.productType ?? null;
  const snippets: string[] = [];

  for (const e of evidence) {
    const val = typeof e.value === 'string' ? e.value : (e.snippet ?? '');
    const sourceField = (e.sourceField ?? '').toLowerCase();

    if (!name && (sourceField.includes('name') || sourceField.includes('title'))) {
      name = val;
    } else if (!brand && (sourceField.includes('brand') || e.attributeId === 'brand')) {
      brand = typeof e.value === 'string' ? e.value : null;
    } else if (!productType && (sourceField.includes('producttype') || e.attributeId === 'primary_product_type')) {
      productType = typeof e.value === 'string' ? e.value : null;
    }

    if (e.snippet && !snippets.includes(e.snippet)) {
      snippets.push(e.snippet);
    } else if (typeof e.value === 'string' && e.value && !snippets.includes(e.value)) {
      snippets.push(e.value);
    }
  }

  const baseState: BoundedAttributeState = {
    sku,
    name: name || sku,
    brand,
    productType,
    snippets: snippets.slice(0, 15).map(s => s.slice(0, 500)),
    evidenceText: snippets.slice(0, 15).join('; ').slice(0, 4000),
    evidenceCount: evidence.length,
  };

  const serialized = JSON.stringify(baseState);
  if (Buffer.byteLength(serialized, 'utf-8') > SYSTEMONE_MAX_STATE_BYTES) {
    baseState.snippets = baseState.snippets.slice(0, 5);
    baseState.evidenceText = baseState.evidenceText.slice(0, 1000);
  }

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
  const keyToIdMap = new Map<string, string>();
  const idToKeyMap = new Map<string, string>();
  const criteria: Record<string, string> = {};

  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const key = `opt_${i}`;
    keyToIdMap.set(key, opt.value);
    idToKeyMap.set(opt.value, key);
    const optWithDesc = opt as { value: string; label: string; description?: string };
    const desc = optWithDesc.description ? `: ${optWithDesc.description}` : '';
    criteria[key] = `${opt.label}${desc}`;
  }

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
  const cleanAttrId = attrId.replace(/[^A-Za-z0-9_.-]/g, '_');
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

export function evaluateMultiValueSelectionPolicy(
  params: EvaluateMultiValuePolicyParams,
): MultiValuePolicyOutcome {
  const { target, candidates, permittedEvidence, catalogField, maxItems, minItems } = params;
  const attrId = target.config.attributeId ?? target.config.id;
  const attribute = target.attribute;
  const targetLabel = target.config.label;

  const candidateProbabilities: Record<string, number> = {};
  for (const c of candidates) {
    candidateProbabilities[c.optionLabel] = c.prob;
  }

  const threshold = JEV_MULTI_VALUE_MIN_PROBABILITY; // 0.70
  let qualifying = candidates.filter(c => c.prob >= threshold);

  // If no candidate has sufficient support
  if (qualifying.length === 0) {
    const maxP = Math.max(...candidates.map(c => c.prob), 0);
    const emptyPacket = buildEvidenceTargetPacket(permittedEvidence, {
      attributeId: attrId,
      sourceField: catalogField,
      selectionMode: 'multiple',
      proposedValue: [],
      aliases: attribute?.valueAliases ?? [],
      isGroundingSupport: tokenGroundingSupport,
    });

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

  // Minimum cardinality check if specified
  if (typeof minItems === 'number' && minItems > 0 && qualifying.length < minItems) {
    const emptyPacket = buildEvidenceTargetPacket(permittedEvidence, {
      attributeId: attrId,
      sourceField: catalogField,
      selectionMode: 'multiple',
      proposedValue: [],
      aliases: attribute?.valueAliases ?? [],
      isGroundingSupport: tokenGroundingSupport,
    });
    return {
      outcome: 'abstained',
      abstentionCode: 'insufficient_evidence',
      abstentionReason: `insufficient_evidence: Minimum required values (${minItems}) not met (only ${qualifying.length} qualified).`,
      topProb: qualifying[0]?.prob ?? null,
      candidateProbabilities,
      groundedPacket: emptyPacket,
    };
  }

  // Deterministic ordering: P(yes) desc, then original optionIndex asc
  qualifying.sort((a, b) => b.prob - a.prob || a.optionIndex - b.optionIndex);

  // Cardinality limit check
  if (typeof maxItems === 'number' && maxItems > 0 && qualifying.length > maxItems) {
    const k = maxItems;
    if (qualifying[k - 1].prob === qualifying[k].prob) {
      const tiedProb = qualifying[k].prob;
      const emptyPacket = buildEvidenceTargetPacket(permittedEvidence, {
        attributeId: attrId,
        sourceField: catalogField,
        selectionMode: 'multiple',
        proposedValue: [],
        aliases: attribute?.valueAliases ?? [],
        isGroundingSupport: tokenGroundingSupport,
      });
      return {
        outcome: 'abstained',
        abstentionCode: 'cardinality_limit_exceeded',
        abstentionReason: `cardinality_limit_exceeded: Ambiguity at cardinality limit (${maxItems}): multiple candidates share identical probability (${tiedProb.toFixed(3)}) at the selection boundary.`,
        topProb: qualifying[0].prob,
        candidateProbabilities,
        groundedPacket: emptyPacket,
      };
    }
    qualifying = qualifying.slice(0, maxItems);
  }

  // Claims and composition safeguard (AC 5)
  if (attribute?.isClaim === true || attribute?.isCompositionAttribute === true) {
    const directEligible: typeof qualifying = [];
    for (const c of qualifying) {
      const candPacket = buildEvidenceTargetPacket(permittedEvidence, {
        attributeId: attrId,
        sourceField: catalogField,
        selectionMode: 'single',
        proposedValue: c.optionValue,
        aliases: attribute?.valueAliases ?? [],
        isGroundingSupport: tokenGroundingSupport,
      });
      const hasDirectSupporting = candPacket.supporting.some(
        e => DIRECT_EVIDENCE_SOURCES.has(e.source),
      );
      if (hasDirectSupporting) {
        directEligible.push(c);
      }
    }

    if (directEligible.length === 0) {
      const emptyPacket = buildEvidenceTargetPacket(permittedEvidence, {
        attributeId: attrId,
        sourceField: catalogField,
        selectionMode: 'multiple',
        proposedValue: [],
        aliases: attribute?.valueAliases ?? [],
        isGroundingSupport: tokenGroundingSupport,
      });
      return {
        outcome: 'abstained',
        abstentionCode: 'unsupported_claim',
        abstentionReason: `unsupported_claim: "${targetLabel}" requires target-specific direct product evidence, but none was found. A high probability cannot authorize an unsupported claim or infer a claim from absence.`,
        topProb: qualifying[0]?.prob ?? null,
        candidateProbabilities,
        groundedPacket: emptyPacket,
      };
    }
    qualifying = directEligible;
  }

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

function resolveCredential(provider: string) {
  try {
    const aiConfig = getFullAiRoutingConfig();
    const conn =
      aiConfig.connections[provider] ||
      Object.values(aiConfig.connections).find(
        (c) => c.id === provider || (provider === 'typesafe' && (c.id === 'typesafe-jev' || c.transport === 'systemone')),
      );
    if (conn && conn.credential) {
      return { provider, apiKey: conn.credential, baseUrl: conn.baseUrl, model: null };
    }
  } catch {
    // fallback to api_keys
  }
  const keyRow = getApiKey(provider);
  if (keyRow?.api_key) {
    return { provider, apiKey: keyRow.api_key, baseUrl: keyRow.base_url ?? null, model: null };
  }
  return null;
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
  const packet: EvidenceTargetPacket = buildEvidenceTargetPacket(permittedEvidence, {
    attributeId: attrId,
    sourceField: catalogField,
    selectionMode: cardinality,
    aliases: attribute?.valueAliases ?? [],
    isGroundingSupport: tokenGroundingSupport,
  });

  const text = packet.promptText;
  const evidenceIds = packet.evidenceIds;
  const supportingEvidenceIds = packet.supportingEvidenceIds;
  const contradictingEvidenceIds = packet.contradictingEvidenceIds;

  // 2. Precedence: Reviewed facts
  const reviewedFact = snapshot?.reviewedFacts?.find(
    f => f.proposalType === 'field_assignment' && (f.targetId === attrId || f.targetId === target.config.id),
  );
  if (reviewedFact && reviewedFact.value !== undefined && reviewedFact.value !== null) {
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
  }

  // 3. Precedence: Brand shortcut
  const targetLabel = target.config.label.toLowerCase();
  const isBrandField = targetLabel.includes('brand') || attrId.toLowerCase().includes('brand');

  if (isBrandField) {
    const brandEvidence = permittedEvidence.filter(
      e =>
        e.sourceField === 'resolved_brand'
        || e.sourceField === 'brand'
        || e.attributeId === attrId
        || e.attributeId === 'brand',
    );
    if (brandEvidence.length > 0) {
      const parsedBrands: Array<{ id: string; brandName: string }> = [];
      for (const record of brandEvidence) {
        const parsed = CanonicalBrandEvidenceValueSchema.safeParse(record.value);
        let name: unknown = parsed.success
          ? parsed.data.brandName
          : ((record.value as any)?.brandName ?? (record.value as any)?.name);
        if (typeof name !== 'string' && typeof record.value === 'string') {
          name = record.value;
        }
        const canonicalName = resolveCanonicalAssertion(name, attribute?.valueAliases ?? []);
        if (canonicalName !== null) {
          parsedBrands.push({ id: record.id, brandName: canonicalName });
        }
      }
      if (parsedBrands.length > 0) {
        const uniqueBrands = [...new Set(parsedBrands.map(p => p.brandName))];
        const allBrandIds = parsedBrands.map(p => p.id).filter(Boolean);
        if (uniqueBrands.length === 1) {
          const brandName = uniqueBrands[0];
          const matchedOption = options.find(o =>
            resolveCanonicalAssertion(o.label, attribute?.valueAliases ?? []) === brandName,
          );
          const value = matchedOption?.label ?? brandName;
          return {
            status: 'resolved',
            targetId: attrId,
            value,
            values: cardinality === 'multiple' ? [value] : undefined,
            confidence: 0.9,
            selectedProbability: null,
            vendorConfidence: null,
            probabilityBasis: 'brand_shortcut',
            source: 'brand_resolved',
            derivation: { kind: 'evidence_match' },
            modelCallIds: [],
            evidenceIds: allBrandIds,
            supportingEvidenceIds: allBrandIds,
            contradictingEvidenceIds: [],
          };
        }
      }
    }
  }

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

  // 4. Precedence: Deterministic detail enrichment
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

  // 6. Resolve route through frozen model policy
  const rawPolicy = modelPolicy ?? (snapshot?.modelPolicy as unknown as ModelPolicyView) ?? null;
  const effectivePolicy =
    rawPolicy && typeof rawPolicy === 'object' && 'policyDigest' in rawPolicy && 'providerLocalities' in rawPolicy
      ? rawPolicy
      : null;

  let route: ReturnType<typeof resolveModelRoute> | null = null;
  let conn: any = null;
  let isSystemOne = false;

  if (effectivePolicy) {
    try {
      assertModelPolicyIntact(effectivePolicy);
      const resolvedRoute = resolveModelRoute(effectivePolicy, 'attribute_ranking', {
        getCredential: (p: string) => resolveCredential(p),
        defaultBaseUrls: {
          typesafe: 'https://api.typesafe.ai/v1',
          ollama: 'http://127.0.0.1:11434/v1',
          openai: 'https://api.openai.com/v1',
          deepseek: 'https://api.deepseek.com',
        },
      });
      route = resolvedRoute;
      const aiConfig = getFullAiRoutingConfig();
      conn =
        aiConfig.connections[resolvedRoute.provider] ||
        Object.values(aiConfig.connections).find(
          (c) => c.id === resolvedRoute.provider || (resolvedRoute.provider === 'typesafe' && (c.id === 'typesafe-jev' || c.transport === 'systemone')),
        );
      isSystemOne = resolvedRoute.provider === 'typesafe' || conn?.transport === 'systemone';
    } catch (err) {
      if (err instanceof HeartbeatLostError) throw err;
      if (err instanceof ModelPolicyDeniedError) {
        assertHeld?.();
        insertTerminalModelCall({
          runId,
          stageName: 'product_attribute_proposals',
          operation: 'attribute_ranking',
          attempt: 1,
          provider: err.provider ?? null,
          model: null,
          locality: null,
          snapshotHash: snapshot?.snapshotHash ?? '',
          modelPolicyDigest: effectivePolicy.policyDigest,
          promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS.attribute_ranking,
          ruleVersion: RULE_VERSIONS.attribute_ranking,
          systemPromptHash: '',
          userPromptHash: '',
          status: MODEL_CALL_STATUS.policyDenied,
          errorMessage: err.message,
          costBasis: COST_BASIS.unknown,
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
      throw err;
    }
  }

  // 7. Legacy Chat LLM Fallback (OpenAI / Ollama / DeepSeek)
  if (!isSystemOne) {
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

  // ── TypeSafe Jev System One Path ──────────────────────────────────────────

  // Option limit check: > 253 produces explicit limit abstention (no clipping)
  const cleanAttrId = attrId.replace(/[^A-Za-z0-9_.-]/g, '_');
  if (options.length > MAX_ORDINARY_ATTRIBUTE_CANDIDATES) {
    return {
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
    };
  }

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

  // ── Multi-Value Jev Noul Dispatch ──────────────────────────────────────────
  if (cardinality === 'multiple') {
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
      const questionsRecord: Record<string, { type: 'noul'; instructions: string; criteria: { true: string; false: string } }> = {};
      for (const plan of chunk) {
        questionsRecord[plan.questionId] = {
          type: 'noul',
          instructions: plan.instructions,
          criteria: plan.criteria,
        };
      }

      const request = {
        model: route.model || TYPESAFE_EVALUATED_MODEL,
        state,
        questions: questionsRecord,
      };

      assertHeld?.();
      const promptHash = hashCanonicalJson(request);

      const callId = insertModelCallStart({
        runId,
        stageName: ctx.stage,
        operation: ctx.operation,
        attempt: ctx.attempt,
        provider: route.provider,
        model: route.model,
        requestedModel: route.model,
        locality: route.locality,
        snapshotHash: ctx.snapshotHash,
        modelPolicyDigest: effectivePolicy.policyDigest,
        promptTemplateVersion: ctx.promptTemplateVersion,
        ruleVersion: ctx.ruleVersion,
        systemPromptHash: promptHash,
        userPromptHash: promptHash,
      });
      modelCallIds.push(callId);

      const startedAt = Date.now();
      try {
        assertHeld?.();
        const result = await dispatchSystemOne(jevConn as any, request);
        assertHeld?.();

        if (!isSystemOneModelMatch(request.model, result.returnedModel)) {
          throw new Error(`Model mismatch: requested model "${request.model}", but provider returned "${result.returnedModel}". Pinned model substitution is forbidden.`);
        }

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

        for (const plan of chunk) {
          const answer = result.answers[plan.questionId];
          if (!answer || answer.type !== 'noul') {
            throw new Error(`Expected noul answer for question "${plan.questionId}", got "${answer?.type ?? 'missing'}".`);
          }
          candidates.push({
            optionValue: plan.optionValue,
            optionLabel: plan.optionLabel,
            optionIndex: plan.optionIndex,
            prob: answer.noul,
          });
        }
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
        return {
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
          derivation: {
            kind: 'systemone_judgment',
            primitive: 'noul',
            questionId: `attr_${cleanAttrId}`,
            selectedProbability: null,
            vendorConfidence: null,
            probabilityBasis: 'noul_probability',
            abstentionCode: 'service_failure',
          },
          modelCallIds,
          evidenceIds: packet.evidenceIds,
          supportingEvidenceIds: packet.supportingEvidenceIds,
          contradictingEvidenceIds: packet.contradictingEvidenceIds,
          error: err,
        };
      }
    }

    // All candidate questions successfully answered: apply evaluated frozen selection policy
    const policyOutcome = evaluateMultiValueSelectionPolicy({
      target,
      candidates,
      permittedEvidence,
      catalogField,
      maxItems: params.constraints?.maxItems,
      minItems: params.constraints?.minItems,
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
        derivation: {
          kind: 'systemone_judgment',
          primitive: 'noul',
          questionId: `attr_${cleanAttrId}`,
          selectedProbability: policyOutcome.topProb,
          vendorConfidence: null,
          probabilityBasis: 'noul_probability',
          abstentionCode: policyOutcome.abstentionCode,
          candidateProbabilities: policyOutcome.candidateProbabilities,
        },
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
      derivation: {
        kind: 'systemone_judgment',
        primitive: 'noul',
        questionId: `attr_${cleanAttrId}`,
        selectedProbability: policyOutcome.topProb,
        vendorConfidence: null,
        probabilityBasis: 'noul_probability',
        candidateProbabilities: policyOutcome.candidateProbabilities,
      },
      modelCallIds,
      evidenceIds: policyOutcome.groundedPacket.evidenceIds,
      supportingEvidenceIds: policyOutcome.groundedPacket.supportingEvidenceIds,
      contradictingEvidenceIds: policyOutcome.groundedPacket.contradictingEvidenceIds,
      hasConflict: policyOutcome.groundedPacket.hasConflict,
    };
  }

  // ── Single Choice Jev Path ────────────────────────────────────────────────
  // Build question and bounded state
  const questionPlan = buildAttributeChoiceQuestion(target);
  const state = buildAttributeState(permittedEvidence, sku, productContext);

  const request = {
    model: route.model || TYPESAFE_EVALUATED_MODEL,
    state,
    questions: {
      [questionPlan.questionId]: {
        type: 'choice' as const,
        instructions: questionPlan.instructions,
        criteria: questionPlan.criteria,
      },
    },
  };

  const promptHash = hashCanonicalJson(request);

  const callId = insertModelCallStart({
    runId,
    stageName: ctx.stage,
    operation: ctx.operation,
    attempt: ctx.attempt,
    provider: route.provider,
    model: route.model,
    requestedModel: route.model,
    locality: route.locality,
    snapshotHash: ctx.snapshotHash,
    modelPolicyDigest: effectivePolicy.policyDigest,
    promptTemplateVersion: ctx.promptTemplateVersion,
    ruleVersion: ctx.ruleVersion,
    systemPromptHash: promptHash,
    userPromptHash: promptHash,
  });

  const startedAt = Date.now();

  try {
    assertHeld?.();
    const result = await dispatchSystemOne(jevConn as any, request);
    assertHeld?.();

    if (!isSystemOneModelMatch(request.model, result.returnedModel)) {
      throw new Error(`Model mismatch: requested model "${request.model}", but provider returned "${result.returnedModel}". Pinned model substitution is forbidden.`);
    }

    const durationMs = Date.now() - startedAt;
    const answer = result.answers[questionPlan.questionId];

    if (!answer || answer.type !== 'choice') {
      throw new Error(`Expected choice answer for question "${questionPlan.questionId}", got "${answer?.type ?? 'missing'}".`);
    }

    const choiceKey = answer.choice;
    const selectedProbability = answer.probabilities[choiceKey] ?? 0;
    const vendorConfidence = answer.confidence;

    completeModelCall(callId, {
      status: MODEL_CALL_STATUS.success,
      endedAt: now(),
      durationMs,
      promptTokens: result.usage.inputTokens,
      completionTokens: result.usage.outputTokens,
      resolvedModel: result.returnedModel,
      typedResultMetadata: {
        questionId: questionPlan.questionId,
        choice: choiceKey,
        canonicalId: questionPlan.keyToIdMap.get(choiceKey) ?? null,
        resolvedId: questionPlan.keyToIdMap.get(choiceKey) ?? null,
        selectedProbability,
        vendorConfidence,
        basis: 'choice_probability',
      },
    });

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
        derivation: {
          kind: 'systemone_judgment',
          primitive: 'choice',
          questionId: questionPlan.questionId,
          selectedProbability,
          vendorConfidence,
          probabilityBasis: 'choice_probability',
          abstentionCode: 'no_match',
        },
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
        derivation: {
          kind: 'systemone_judgment',
          primitive: 'choice',
          questionId: questionPlan.questionId,
          selectedProbability,
          vendorConfidence,
          probabilityBasis: 'choice_probability',
          abstentionCode: 'insufficient_evidence',
        },
        modelCallIds: [callId],
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      };
    }

    const canonicalValue = questionPlan.keyToIdMap.get(choiceKey);
    if (!canonicalValue) {
      throw new Error(`Returned choice key "${choiceKey}" does not map to any canonical option value.`);
    }

    // Check development-fitted eligibility floor (0.50)
    if (selectedProbability < JEV_ATTRIBUTE_MIN_PROBABILITY) {
      return {
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
        derivation: {
          kind: 'systemone_judgment',
          primitive: 'choice',
          questionId: questionPlan.questionId,
          selectedProbability,
          vendorConfidence,
          probabilityBasis: 'choice_probability',
          abstentionCode: 'low_probability',
        },
        modelCallIds: [callId],
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      };
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
        return {
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
          derivation: {
            kind: 'systemone_judgment',
            primitive: 'choice',
            questionId: questionPlan.questionId,
            selectedProbability,
            vendorConfidence,
            probabilityBasis: 'choice_probability',
            abstentionCode: 'unsupported_claim',
          },
          modelCallIds: [callId],
          evidenceIds: groundedPacket.evidenceIds,
          supportingEvidenceIds: groundedPacket.supportingEvidenceIds,
          contradictingEvidenceIds: groundedPacket.contradictingEvidenceIds,
        };
      }
    }

    return {
      status: 'resolved',
      targetId: attrId,
      value: canonicalValue,
      confidence: selectedProbability,
      selectedProbability,
      vendorConfidence,
      probabilityBasis: 'choice_probability',
      source: 'jev',
      derivation: {
        kind: 'systemone_judgment',
        primitive: 'choice',
        questionId: questionPlan.questionId,
        selectedProbability,
        vendorConfidence,
        probabilityBasis: 'choice_probability',
      },
      modelCallIds: [callId],
      evidenceIds: groundedPacket.evidenceIds,
      supportingEvidenceIds: groundedPacket.supportingEvidenceIds,
      contradictingEvidenceIds: groundedPacket.contradictingEvidenceIds,
      hasConflict: groundedPacket.hasConflict,
    };
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
      derivation: {
        kind: 'systemone_judgment',
        primitive: 'choice',
        questionId: questionPlan.questionId,
        selectedProbability: null,
        vendorConfidence: null,
        probabilityBasis: 'choice_probability',
        abstentionCode: 'service_failure',
      },
      modelCallIds: [callId],
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
      error: err,
    };
  }
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
export async function batchResolveAttributeDecisions(
  params: BatchAttributeDecisionParams,
): Promise<AttributeDecisionResult[]> {
  const { items, evidence, sku, runId, snapshot, modelPolicy, assertHeld, productContext } = params;
  const results: AttributeDecisionResult[] = [];

  // Group items that need Jev resolution vs deterministic / unsupported
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

  const pendingJevItems: PendingJevItem[] = [];

  for (const item of items) {
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

    // 1. Reviewed facts precedence
    const reviewedFact = snapshot?.reviewedFacts?.find(
      f => f.proposalType === 'field_assignment' && (f.targetId === attrId || f.targetId === target.config.id),
    );
    if (reviewedFact && reviewedFact.value !== undefined && reviewedFact.value !== null) {
      let values: string[] | undefined;
      let value: string;
      if (Array.isArray(reviewedFact.value)) {
        values = reviewedFact.value.map(String);
        value = values.join(', ');
      } else {
        value = String(reviewedFact.value);
        values = [value];
      }
      results.push({
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
        evidenceIds: packet.evidenceIds,
        supportingEvidenceIds: packet.supportingEvidenceIds,
        contradictingEvidenceIds: packet.contradictingEvidenceIds,
      });
      continue;
    }

    // 2. Precedence: Brand shortcut
    const targetLabel = target.config.label.toLowerCase();
    const isBrandField = targetLabel.includes('brand') || attrId.toLowerCase().includes('brand');

    if (isBrandField) {
      const brandEvidence = permittedEvidence.filter(
        e =>
          e.sourceField === 'resolved_brand'
          || e.sourceField === 'brand'
          || e.attributeId === attrId
          || e.attributeId === 'brand',
      );
      if (brandEvidence.length > 0) {
        const parsedBrands: Array<{ id: string; brandName: string }> = [];
        for (const record of brandEvidence) {
          const parsed = CanonicalBrandEvidenceValueSchema.safeParse(record.value);
          let name: unknown = parsed.success
            ? parsed.data.brandName
            : ((record.value as any)?.brandName ?? (record.value as any)?.name);
          if (typeof name !== 'string' && typeof record.value === 'string') {
            name = record.value;
          }
          const canonicalName = resolveCanonicalAssertion(name, attribute?.valueAliases ?? []);
          if (canonicalName !== null) {
            parsedBrands.push({ id: record.id, brandName: canonicalName });
          }
        }
        if (parsedBrands.length > 0) {
          const uniqueBrands = [...new Set(parsedBrands.map(p => p.brandName))];
          const allBrandIds = parsedBrands.map(p => p.id).filter(Boolean);
          if (uniqueBrands.length === 1) {
            const brandName = uniqueBrands[0];
            const matchedOption = options.find(o =>
              resolveCanonicalAssertion(o.label, attribute?.valueAliases ?? []) === brandName,
            );
            const value = matchedOption?.label ?? brandName;
            results.push({
              status: 'resolved',
              targetId: attrId,
              value,
              values: cardinality === 'multiple' ? [value] : undefined,
              confidence: 0.9,
              selectedProbability: null,
              vendorConfidence: null,
              probabilityBasis: 'brand_shortcut',
              source: 'brand_resolved',
              derivation: { kind: 'evidence_match' },
              modelCallIds: [],
              evidenceIds: allBrandIds,
              supportingEvidenceIds: allBrandIds,
              contradictingEvidenceIds: [],
            });
            continue;
          }
        }
      }
    }

    // 3. Precedence: Deterministic alias/exact matches
    const optionStrings = options.map(o => o.label);
    const aliasMatches = attribute
      ? matchAttributeOptions(attribute, text, optionStrings, cardinality)
      : [];

    if (aliasMatches.length > 0) {
      if (cardinality === 'multiple') {
        const matchedVals = aliasMatches.map(m => m.value);
        results.push({
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
          evidenceIds: packet.evidenceIds,
          supportingEvidenceIds: packet.supportingEvidenceIds,
          contradictingEvidenceIds: packet.contradictingEvidenceIds,
        });
        continue;
      }
      const top = aliasMatches[0];
      results.push({
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
        evidenceIds: packet.evidenceIds,
        supportingEvidenceIds: packet.supportingEvidenceIds,
        contradictingEvidenceIds: packet.contradictingEvidenceIds,
      });
      continue;
    }

    // 4. Precedence: Deterministic detail enrichment
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
          results.push({
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
            evidenceIds: packet.evidenceIds,
            supportingEvidenceIds: packet.supportingEvidenceIds,
            contradictingEvidenceIds: packet.contradictingEvidenceIds,
          });
          continue;
        }
        const top = matching[0];
        results.push({
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
          evidenceIds: packet.evidenceIds,
          supportingEvidenceIds: packet.supportingEvidenceIds,
          contradictingEvidenceIds: packet.contradictingEvidenceIds,
        });
        continue;
      }
    }

    // 5. Check empty options
    if (options.length === 0) {
      results.push({
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
        evidenceIds: packet.evidenceIds,
        supportingEvidenceIds: packet.supportingEvidenceIds,
        contradictingEvidenceIds: packet.contradictingEvidenceIds,
      });
      continue;
    }

    // 6. Option limit check
    const cleanAttrId = attrId.replace(/[^A-Za-z0-9_.-]/g, '_');
    if (options.length > MAX_ORDINARY_ATTRIBUTE_CANDIDATES) {
      results.push({
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
      });
      continue;
    }

    // Build question plan and state
    const state = buildAttributeState(permittedEvidence, sku, productContext);
    const stateHash = hashCanonicalJson(state);

    if (cardinality === 'multiple') {
      const noulPlans = buildAttributeNoulQuestions(target, sku, productContext);
      pendingJevItems.push({
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
      });
    } else {
      const questionPlan = buildAttributeChoiceQuestion(target);
      pendingJevItems.push({
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
      });
    }
  }

  if (pendingJevItems.length === 0) {
    return results;
  }

  // Resolve route through frozen model policy
  const rawPolicy = modelPolicy ?? (snapshot?.modelPolicy as unknown as ModelPolicyView) ?? null;
  const effectivePolicy =
    rawPolicy && typeof rawPolicy === 'object' && 'policyDigest' in rawPolicy && 'providerLocalities' in rawPolicy
      ? rawPolicy
      : null;

  let route: ReturnType<typeof resolveModelRoute> | null = null;
  let conn: any = null;
  let isSystemOne = false;

  if (effectivePolicy) {
    try {
      assertModelPolicyIntact(effectivePolicy);
      const resolvedRoute = resolveModelRoute(effectivePolicy, 'attribute_ranking', {
        getCredential: (p: string) => resolveCredential(p),
        defaultBaseUrls: {
          typesafe: 'https://api.typesafe.ai/v1',
          ollama: 'http://127.0.0.1:11434/v1',
          openai: 'https://api.openai.com/v1',
          deepseek: 'https://api.deepseek.com',
        },
      });
      route = resolvedRoute;
      const aiConfig = getFullAiRoutingConfig();
      conn =
        aiConfig.connections[resolvedRoute.provider] ||
        Object.values(aiConfig.connections).find(
          (c) => c.id === resolvedRoute.provider || (resolvedRoute.provider === 'typesafe' && (c.id === 'typesafe-jev' || c.transport === 'systemone')),
        );
      isSystemOne = resolvedRoute.provider === 'typesafe' || conn?.transport === 'systemone';
    } catch (err) {
      if (err instanceof HeartbeatLostError) throw err;
      if (err instanceof ModelPolicyDeniedError) {
        assertHeld?.();
        insertTerminalModelCall({
          runId,
          stageName: 'product_attribute_proposals',
          operation: 'attribute_ranking',
          attempt: 1,
          provider: err.provider ?? null,
          model: null,
          locality: null,
          snapshotHash: snapshot?.snapshotHash ?? '',
          modelPolicyDigest: effectivePolicy.policyDigest,
          promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS.attribute_ranking,
          ruleVersion: RULE_VERSIONS.attribute_ranking,
          systemPromptHash: '',
          userPromptHash: '',
          status: MODEL_CALL_STATUS.policyDenied,
          errorMessage: err.message,
          costBasis: COST_BASIS.unknown,
        });
        for (const p of pendingJevItems) {
          results.push({
            status: 'abstained',
            targetId: p.attrId,
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
            evidenceIds: p.packet.evidenceIds,
            supportingEvidenceIds: p.packet.supportingEvidenceIds,
            contradictingEvidenceIds: p.packet.contradictingEvidenceIds,
          });
        }
        return results;
      }
      throw err;
    }
  }

  // If not SystemOne, fall back to individual chat LLM calls
  if (!isSystemOne) {
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
      results.push(singleRes);
    }
    return results;
  }

  // Group pending Jev items by identical stateHash
  const groupsByState = new Map<string, PendingJevItem[]>();
  for (const item of pendingJevItems) {
    const list = groupsByState.get(item.stateHash);
    if (list) list.push(item);
    else groupsByState.set(item.stateHash, [item]);
  }

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

  // Process each state group: identical state items are batched into requests of <= 32 questions
  for (const [, group] of groupsByState) {
    const groupState = group[0].state;

    type StateQuestion =
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

    const stateQuestions: StateQuestion[] = [];
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
    const questionChunks: StateQuestion[][] = [];
    for (let i = 0; i < stateQuestions.length; i += SYSTEMONE_MAX_QUESTIONS) {
      questionChunks.push(stateQuestions.slice(i, i + SYSTEMONE_MAX_QUESTIONS));
    }

    const allAnswers: Record<string, any> = {};
    const targetErrors = new Map<string, string>();
    const targetModelCallIds = new Map<string, string[]>();

    for (const item of group) {
      targetModelCallIds.set(item.attrId, []);
    }

    for (const chunk of questionChunks) {
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

      const callId = insertModelCallStart({
        runId,
        stageName: ctx.stage,
        operation: ctx.operation,
        attempt: ctx.attempt,
        provider: route!.provider,
        model: route!.model,
        requestedModel: route!.model,
        locality: route!.locality,
        snapshotHash: ctx.snapshotHash,
        modelPolicyDigest: effectivePolicy!.policyDigest,
        promptTemplateVersion: ctx.promptTemplateVersion,
        ruleVersion: ctx.ruleVersion,
        systemPromptHash: promptHash,
        userPromptHash: promptHash,
      });

      const touchedTargets = new Set(chunk.map(q => q.targetAttrId));
      for (const tId of touchedTargets) {
        targetModelCallIds.get(tId)?.push(callId);
      }

      const startedAt = Date.now();
      try {
        assertHeld?.();
        const dispatchRes = await dispatchSystemOne(jevConn as any, request);
        assertHeld?.();

        if (!isSystemOneModelMatch(request.model, dispatchRes.returnedModel)) {
          throw new Error(`Model mismatch: requested model "${request.model}", but provider returned "${dispatchRes.returnedModel}". Pinned model substitution is forbidden.`);
        }

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

        const errMessage = err instanceof Error ? err.message : String(err);
        for (const tId of touchedTargets) {
          targetErrors.set(tId, errMessage);
        }
      }
    }

    // Now process answers for each item in the group
    for (const item of group) {
      const callIds = targetModelCallIds.get(item.attrId) ?? [];
      const errorMsg = targetErrors.get(item.attrId);

      if (errorMsg) {
        results.push({
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
        });
        continue;
      }

      if (item.kind === 'choice') {
        const answer = allAnswers[item.questionPlan.questionId];
        if (!answer || answer.type !== 'choice') {
          results.push({
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
            derivation: {
              kind: 'systemone_judgment',
              primitive: 'choice',
              questionId: item.questionPlan.questionId,
              selectedProbability: null,
              vendorConfidence: null,
              probabilityBasis: 'choice_probability',
              abstentionCode: 'service_failure',
            },
            modelCallIds: callIds,
            evidenceIds: item.packet.evidenceIds,
            supportingEvidenceIds: item.packet.supportingEvidenceIds,
            contradictingEvidenceIds: item.packet.contradictingEvidenceIds,
          });
          continue;
        }

        const choiceKey = answer.choice;
        const selectedProbability = answer.probabilities[choiceKey] ?? 0;
        const vendorConfidence = answer.confidence;

        if (choiceKey === NO_MATCH_CHOICE_KEY) {
          results.push({
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
            derivation: {
              kind: 'systemone_judgment',
              primitive: 'choice',
              questionId: item.questionPlan.questionId,
              selectedProbability,
              vendorConfidence,
              probabilityBasis: 'choice_probability',
              abstentionCode: 'no_match',
            },
            modelCallIds: callIds,
            evidenceIds: item.packet.evidenceIds,
            supportingEvidenceIds: item.packet.supportingEvidenceIds,
            contradictingEvidenceIds: item.packet.contradictingEvidenceIds,
          });
          continue;
        }

        if (choiceKey === INSUFFICIENT_EVIDENCE_CHOICE_KEY) {
          results.push({
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
            derivation: {
              kind: 'systemone_judgment',
              primitive: 'choice',
              questionId: item.questionPlan.questionId,
              selectedProbability,
              vendorConfidence,
              probabilityBasis: 'choice_probability',
              abstentionCode: 'insufficient_evidence',
            },
            modelCallIds: callIds,
            evidenceIds: item.packet.evidenceIds,
            supportingEvidenceIds: item.packet.supportingEvidenceIds,
            contradictingEvidenceIds: item.packet.contradictingEvidenceIds,
          });
          continue;
        }

        const canonicalValue = item.questionPlan.keyToIdMap.get(choiceKey);
        if (!canonicalValue) {
          results.push({
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
            derivation: {
              kind: 'systemone_judgment',
              primitive: 'choice',
              questionId: item.questionPlan.questionId,
              selectedProbability,
              vendorConfidence,
              probabilityBasis: 'choice_probability',
              abstentionCode: 'service_failure',
            },
            modelCallIds: callIds,
            evidenceIds: item.packet.evidenceIds,
            supportingEvidenceIds: item.packet.supportingEvidenceIds,
            contradictingEvidenceIds: item.packet.contradictingEvidenceIds,
          });
          continue;
        }

        if (selectedProbability < JEV_ATTRIBUTE_MIN_PROBABILITY) {
          results.push({
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
            derivation: {
              kind: 'systemone_judgment',
              primitive: 'choice',
              questionId: item.questionPlan.questionId,
              selectedProbability,
              vendorConfidence,
              probabilityBasis: 'choice_probability',
              abstentionCode: 'low_probability',
            },
            modelCallIds: callIds,
            evidenceIds: item.packet.evidenceIds,
            supportingEvidenceIds: item.packet.supportingEvidenceIds,
            contradictingEvidenceIds: item.packet.contradictingEvidenceIds,
          });
          continue;
        }

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
            results.push({
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
              derivation: {
                kind: 'systemone_judgment',
                primitive: 'choice',
                questionId: item.questionPlan.questionId,
                selectedProbability,
                vendorConfidence,
                probabilityBasis: 'choice_probability',
                abstentionCode: 'unsupported_claim',
              },
              modelCallIds: callIds,
              evidenceIds: groundedPacket.evidenceIds,
              supportingEvidenceIds: groundedPacket.supportingEvidenceIds,
              contradictingEvidenceIds: groundedPacket.contradictingEvidenceIds,
            });
            continue;
          }
        }

        results.push({
          status: 'resolved',
          targetId: item.attrId,
          value: canonicalValue,
          confidence: selectedProbability,
          selectedProbability,
          vendorConfidence,
          probabilityBasis: 'choice_probability',
          source: 'jev',
          derivation: {
            kind: 'systemone_judgment',
            primitive: 'choice',
            questionId: item.questionPlan.questionId,
            selectedProbability,
            vendorConfidence,
            probabilityBasis: 'choice_probability',
          },
          modelCallIds: callIds,
          evidenceIds: groundedPacket.evidenceIds,
          supportingEvidenceIds: groundedPacket.supportingEvidenceIds,
          contradictingEvidenceIds: groundedPacket.contradictingEvidenceIds,
          hasConflict: groundedPacket.hasConflict,
        });
      } else {
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
          results.push({
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
            derivation: {
              kind: 'systemone_judgment',
              primitive: 'noul',
              questionId: `attr_${item.cleanAttrId}`,
              selectedProbability: null,
              vendorConfidence: null,
              probabilityBasis: 'noul_probability',
              abstentionCode: 'service_failure',
            },
            modelCallIds: callIds,
            evidenceIds: item.packet.evidenceIds,
            supportingEvidenceIds: item.packet.supportingEvidenceIds,
            contradictingEvidenceIds: item.packet.contradictingEvidenceIds,
          });
          continue;
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
          results.push({
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
            derivation: {
              kind: 'systemone_judgment',
              primitive: 'noul',
              questionId: `attr_${item.cleanAttrId}`,
              selectedProbability: policyOutcome.topProb,
              vendorConfidence: null,
              probabilityBasis: 'noul_probability',
              abstentionCode: policyOutcome.abstentionCode,
              candidateProbabilities: policyOutcome.candidateProbabilities,
            },
            modelCallIds: callIds,
            evidenceIds: policyOutcome.groundedPacket.evidenceIds,
            supportingEvidenceIds: policyOutcome.groundedPacket.supportingEvidenceIds,
            contradictingEvidenceIds: policyOutcome.groundedPacket.contradictingEvidenceIds,
          });
        } else {
          results.push({
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
            derivation: {
              kind: 'systemone_judgment',
              primitive: 'noul',
              questionId: `attr_${item.cleanAttrId}`,
              selectedProbability: policyOutcome.topProb,
              vendorConfidence: null,
              probabilityBasis: 'noul_probability',
              candidateProbabilities: policyOutcome.candidateProbabilities,
            },
            modelCallIds: callIds,
            evidenceIds: policyOutcome.groundedPacket.evidenceIds,
            supportingEvidenceIds: policyOutcome.groundedPacket.supportingEvidenceIds,
            contradictingEvidenceIds: policyOutcome.groundedPacket.contradictingEvidenceIds,
            hasConflict: policyOutcome.groundedPacket.hasConflict,
          });
        }
      }
    }
  }

  return results;
}

// ─── Build Proposal from Decision Result ──────────────────────────────────────

export function buildProposalFromAttributeDecision(
  decision: AttributeDecisionResult,
  sku: string,
  runId: string,
  snapshotHash?: string | null,
): ClassificationProposal {
  if (decision.status === 'resolved' && (decision.value !== null || (decision.values && decision.values.length > 0))) {
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
