/**
 * Canonical Product Type Decision Boundary (Issue #297 / ADR 0033).
 *
 * Single internal canonical-decision boundary for Product Type classification,
 * consumed identically by singleton SKU curation and cohort freeze.
 *
 * Enforces:
 * - Deterministic matching and reviewed facts retain precedence.
 * - TypeSafe Jev System One Choice dispatch when provider is configured for System One.
 * - Choice criteria over complete eligible Product Types plus explicit `no_match`
 *   and `insufficient_evidence` outcomes.
 * - Request-local option keys map directly to canonical IDs (supporting duplicate labels).
 * - Maximum 253 ordinary candidates; >253 produces explicit limit abstention (no clipping).
 * - Centralized, versioned question definitions, bounded state builder, and eligibility policy.
 * - Stored selected probability and vendor concentration confidence separated with explicit basis.
 * - Development-fitted threshold (0.50 floor); no clamps or probability boosting.
 * - Protected execution with audit rows in `classification_model_calls` and lease assertions.
 * - Fallback to existing chat LLM ranker when provider is openai-compatible/ollama-native.
 */

import {
    TYPESAFE_EVALUATED_MODEL,
} from '../ai/systemone-transport';
import { assertConnectionEnabledForDispatch } from '../ai/provider-connections';
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
  type EvidenceTargetPacket,
} from './evidence-targeting';
import { matchKeywordOptions } from './curation-target-matcher';
import { llmRankOptions } from './curation-target-ranker';
import { mapRankedLabelToOptionExactlyOne } from './cohort-product-type-resolver';
import type { ResolvedTarget, ResolvedTargetOption } from './curation-target-resolver';
import type { ClassificationEvidence, ProposalDerivation } from '../shared/schemas/classification';
import {
  MAX_ORDINARY_CHOICE_CANDIDATES,
  SYSTEMONE_SINGLE_CHOICE_MIN_PROBABILITY,
    buildChoiceJudgmentDerivation,
  buildChoiceKeyMaps,
  choiceKeyToCanonicalId,
  evidenceTextValue,
  fitStateToBudget,
    asEffectivePolicyView,
  insertPolicyDeniedTerminalCall,
  openSingleChoiceRequest,
  resolveDecisionRouteForOperation,
  runSingleChoiceDispatch,
  sourceFieldOf,
  truncateSnippets,
} from './systemone-decision-core';

// ─── Versioned Constants ──────────────────────────────────────────────────────

const MAX_ORDINARY_PRODUCT_TYPE_CANDIDATES = MAX_ORDINARY_CHOICE_CANDIDATES; // 253

const JEV_PRODUCT_TYPE_QUESTION_ID = 'primary_product_type';
const NO_MATCH_CHOICE_KEY = 'no_match';
const INSUFFICIENT_EVIDENCE_CHOICE_KEY = 'insufficient_evidence';

/**
 * Development-fitted minimum probability for Jev Choice selection.
 * Tuned on representative Pet & Garden assortment examples.
 * An ungrounded option pick below 0.50 probability is an explicit semantic abstention.
 */
export const JEV_PRODUCT_TYPE_MIN_PROBABILITY = SYSTEMONE_SINGLE_CHOICE_MIN_PROBABILITY; // 0.50

export const PRODUCT_TYPE_KEYWORD_MATCH_MIN_CONFIDENCE = 0.7;

const now = () => new Date().toISOString();

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProductTypeDecisionParams {
  target: ResolvedTarget;
  evidence: ClassificationEvidence[];
  sku: string;
  runId: string;
  snapshot?: RuntimeClassificationSnapshot | null;
  modelPolicy?: ModelPolicyView | null;
  confidenceFloor?: number;
  assertHeld?: () => void;
  deterministicMatch?: {
    productTypeId: string | null;
    confidence: number | null;
    source: 'keyword' | null;
  } | null;
}

export type ProductTypeDecisionStatus = 'resolved' | 'abstained' | 'failed';

export interface ProductTypeDecisionResult {
  status: ProductTypeDecisionStatus;
  productTypeId: string | null;
  confidence: number;
  selectedProbability: number | null;
  vendorConfidence: number | null;
  probabilityBasis: string | null;
  source: 'keyword' | 'llm' | 'jev';
  abstentionCode?:
    | 'no_match'
    | 'insufficient_evidence'
    | 'low_probability'
    | 'candidate_limit_exceeded'
    | 'service_failure'
    | 'policy_denied'
    | 'no_confident_match';
  abstentionReason?: string | null;
  derivation: ProposalDerivation;
  modelCallIds: string[];
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  error?: unknown;
}

// ─── Bounded State Builder ───────────────────────────────────────────────────

interface BoundedProductTypeState {
  sku: string;
  name: string;
  brand: string | null;
  description: string | null;
  snippets: string[];
  attributes: Record<string, unknown>;
  evidenceCount: number;
}

type ProductTypeEvidenceSlot = 'name' | 'brand' | 'description';

interface ProductTypeStateAccumulator {
  name: string;
  brand: string | null;
  description: string | null;
}

/**
 * All state slots one evidence record matches, in priority order. A record
 * may match several slots (e.g. a brand name field); guards stay with the
 * collector so first-wins cascade order is preserved exactly.
 */
function matchingProductTypeEvidenceSlots(
  sourceField: string,
  attributeId: string | null | undefined,
): ProductTypeEvidenceSlot[] {
  const slots: ProductTypeEvidenceSlot[] = [];
  if (sourceField.includes('name') || sourceField.includes('title')) slots.push('name');
  if (sourceField.includes('brand') || attributeId === 'brand') slots.push('brand');
  if (sourceField.includes('description')) slots.push('description');
  return slots;
}

/**
 * Try to place one evidence value into the first matching open slot.
 * Returns true when placed (mirrors the original else-if cascade exactly).
 */
function tryPlaceProductTypeSlot(
  acc: ProductTypeStateAccumulator,
  slot: ProductTypeEvidenceSlot,
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
  if (slot === 'description' && !acc.description) {
    acc.description = val;
    return true;
  }
  return false;
}

/**
 * Collect name/brand/description/snippets from product evidence (first wins).
 */
function collectProductTypeStateFields(
  evidence: ClassificationEvidence[],
): { name: string; brand: string | null; description: string | null; snippets: string[] } {
  const acc: ProductTypeStateAccumulator = { name: '', brand: null, description: null };
  const snippets: string[] = [];
  for (const e of evidence) {
    const val = evidenceTextValue(e);
    const sourceField = sourceFieldOf(e);
    let placed = false;
    for (const slot of matchingProductTypeEvidenceSlots(sourceField, e.attributeId)) {
      if (tryPlaceProductTypeSlot(acc, slot, val, e)) {
        placed = true;
        break;
      }
    }
    if (!placed && e.snippet) snippets.push(e.snippet);
  }
  return { name: acc.name, brand: acc.brand, description: acc.description, snippets };
}

/**
 * Collect per-attribute values from product evidence.
 */
function collectProductTypeStateAttributes(
  evidence: ClassificationEvidence[],
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const e of evidence) {
    if (e.attributeId && e.value != null) {
      attributes[e.attributeId] = e.value;
    }
  }
  return attributes;
}

/**
 * Builds bounded structured state from product evidence, capped at 32k bytes.
 */
function buildProductTypeState(
  evidence: ClassificationEvidence[],
  sku: string,
): BoundedProductTypeState {
  const collected = collectProductTypeStateFields(evidence);
  const name = collected.name;
  const brand = collected.brand;
  const description = collected.description;
  const snippets = collected.snippets;
  const attributes = collectProductTypeStateAttributes(evidence);

  const baseState: BoundedProductTypeState = {
    sku,
    name: name || sku,
    brand,
    description: description ? description.slice(0, 4000) : null,
    snippets: truncateSnippets(snippets),
    attributes,
    evidenceCount: evidence.length,
  };

  // Ensure state serialization fits within the SystemOne state budget (32,768 bytes)
  fitStateToBudget(baseState, s => {
    s.snippets = s.snippets.slice(0, 5);
    if (s.description) {
      s.description = s.description.slice(0, 1000);
    }
  });

  return baseState;
}

// ─── Question Builder ─────────────────────────────────────────────────────────

export interface ProductTypeChoiceQuestionPlan {
  questionId: string;
  instructions: string;
  criteria: Record<string, string>;
  keyToIdMap: Map<string, string>;
  idToKeyMap: Map<string, string>;
}

export function buildProductTypeChoiceQuestion(
  options: ResolvedTargetOption[],
): ProductTypeChoiceQuestionPlan {
  const criteria: Record<string, string> = {};
  const { keyToIdMap, idToKeyMap } = buildChoiceKeyMaps(criteria, options, 'opt');

  // Two dedicated abstention outcomes
  criteria[NO_MATCH_CHOICE_KEY] =
    'None of the specific product types listed above fit this product.';
  criteria[INSUFFICIENT_EVIDENCE_CHOICE_KEY] =
    'The evidence provided is insufficient, ambiguous, or lacks essential product identity details to determine a product type with confidence.';

  const instructions =
    'Identify the primary product type that best categorizes this product from the available choices based strictly on the provided product evidence. If none of the specific product types fit the product, select "no_match". If the evidence does not provide enough information to determine the type with confidence, select "insufficient_evidence".';

  return {
    questionId: JEV_PRODUCT_TYPE_QUESTION_ID,
    instructions,
    criteria,
    keyToIdMap,
    idToKeyMap,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Deterministic precedence for product type: explicit caller match, keyword
 * match over the evidence text, then the empty-taxonomy abstention.
 * Returns a terminal result when precedence applies, otherwise null.
 */
/**
 * Explicit caller-supplied deterministic product-type match with an optional
 * confidence floor.
 */
function matchProductTypeDeterministicParam(input: {
  match: { productTypeId: string; confidence: number | null };
  confidenceFloor?: number;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): ProductTypeDecisionResult | null {
  const { match, confidenceFloor, evidenceIds, supportingEvidenceIds, contradictingEvidenceIds } = input;
    const meetsFloor =
      confidenceFloor !== undefined ? (match.confidence ?? 0) >= confidenceFloor : true;
    if (meetsFloor) {
      return {
        status: 'resolved',
        productTypeId: match.productTypeId,
        confidence: match.confidence ?? 1.0,
        selectedProbability: null,
        vendorConfidence: null,
        probabilityBasis: 'deterministic_keyword',
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

/**
 * Keyword deterministic product-type match over the evidence text with an
 * optional confidence floor.
 */
function matchProductTypeKeyword(input: {
  options: ResolvedTargetOption[];
  text: string;
  confidenceFloor?: number;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): ProductTypeDecisionResult | null {
  const { options, text, confidenceFloor, evidenceIds, supportingEvidenceIds, contradictingEvidenceIds } = input;
  if (options.length > 0 && text && text.length >= 3) {
    const keywordMatches = matchKeywordOptions({
      options,
      text,
      selectionMode: 'single',
    });
    if (keywordMatches.length > 0 && keywordMatches[0].confidence >= PRODUCT_TYPE_KEYWORD_MATCH_MIN_CONFIDENCE) {
      const top = keywordMatches[0];
      const meetsFloor =
        confidenceFloor !== undefined ? top.confidence >= confidenceFloor : true;
      if (meetsFloor) {
        return {
          status: 'resolved',
          productTypeId: top.value,
          confidence: top.confidence,
          selectedProbability: null,
          vendorConfidence: null,
          probabilityBasis: 'deterministic_keyword',
          source: 'keyword',
          derivation: { kind: 'evidence_match' },
          modelCallIds: [],
          evidenceIds,
          supportingEvidenceIds,
          contradictingEvidenceIds,
        };
      }
    }
  }
  return null;
}

function checkProductTypeDeterministicMatch(input: {
  options: ResolvedTargetOption[];
  text: string;
  packet: EvidenceTargetPacket;
  deterministicMatch: ProductTypeDecisionParams['deterministicMatch'];
  confidenceFloor?: number;
}): ProductTypeDecisionResult | null {
  const { options, text, packet, deterministicMatch, confidenceFloor } = input;
  const evidenceIds = packet.evidenceIds;
  const supportingEvidenceIds = packet.supportingEvidenceIds;
  const contradictingEvidenceIds = packet.contradictingEvidenceIds;
  if (deterministicMatch && deterministicMatch.productTypeId !== null) {
    const paramMatch = matchProductTypeDeterministicParam({
      match: {
        productTypeId: deterministicMatch.productTypeId,
        confidence: deterministicMatch.confidence,
      },
      confidenceFloor,
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    });
    if (paramMatch) return paramMatch;
  } else {
    const keywordMatch = matchProductTypeKeyword({
      options,
      text,
      confidenceFloor,
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    });
    if (keywordMatch) return keywordMatch;
  }

  // Target has no options configured
  if (options.length === 0) {
    return {
      status: 'abstained',
      productTypeId: null,
      confidence: 0,
      selectedProbability: null,
      vendorConfidence: null,
      probabilityBasis: null,
      source: 'keyword',
      abstentionCode: 'no_match',
      abstentionReason: 'No product type options configured in taxonomy.',
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
 * Legacy chat-LLM fallback for product type (OpenAI / Ollama / DeepSeek).
 * Used only when the frozen route is not a SystemOne provider.
 */
/**
 * Invoke the legacy chat-LLM ranker for product type.
 */
async function callProductTypeLegacyRanker(input: {
  target: ResolvedTarget;
  options: ResolvedTargetOption[];
  text: string;
  effectivePolicy: ModelPolicyView | null;
  snapshot: RuntimeClassificationSnapshot | null | undefined;
  runId: string;
  assertHeld?: () => void;
}): Promise<Awaited<ReturnType<typeof llmRankOptions>>> {
  const { target, options, text, effectivePolicy, snapshot, runId, assertHeld } = input;
    // ── Legacy Chat LLM Fallback (OpenAI / Ollama / DeepSeek) ─────────────────
    const llmResult = await llmRankOptions({
      targetLabel: target.config.label,
      options,
      selectionMode: 'single',
      evidenceText: text,
      task: 'product_type_classification',
      modelPolicy: effectivePolicy,
      protectedOperation: 'product_type_ranking',
      modelCall: snapshot ? {
        runId,
        snapshotHash: snapshot.snapshotHash,
        stage: 'primary_product_type_proposal',
        operation: 'product_type_ranking',
        attempt: 1,
        promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS.product_type_ranking,
        ruleVersion: RULE_VERSIONS.product_type_ranking,
      } : null,
      snapshot,
      assertHeld,
    });
  return llmResult;
}

/**
 * Map one legacy chat-LLM ranker result to a terminal product-type decision.
 */
function mapProductTypeLlmResult(input: {
  llmResult: Awaited<ReturnType<typeof llmRankOptions>>;
  options: ResolvedTargetOption[];
  effectivePolicy: ModelPolicyView | null;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): ProductTypeDecisionResult {
  const { llmResult, options, effectivePolicy, evidenceIds, supportingEvidenceIds, contradictingEvidenceIds } = input;
    if (!llmResult || llmResult.values.length === 0) {
      return {
        status: 'abstained',
        productTypeId: null,
        confidence: 0,
        selectedProbability: null,
        vendorConfidence: null,
        probabilityBasis: null,
        source: 'llm',
        abstentionCode: 'no_confident_match',
        abstentionReason: 'No confident LLM match found for product type.',
        derivation: { kind: 'llm' },
        modelCallIds: llmResult?.modelCallIds ?? [],
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      };
    }

    return resolveProductTypeLlmSelection({
      llmResult,
      options,
      effectivePolicy,
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    });
}

/**
 * Resolve one legacy ranker result to its canonical product-type selection:
 * unmapped labels abstain, otherwise the mapped id resolves.
 */
function resolveProductTypeLlmSelection(input: {
  llmResult: Exclude<Awaited<ReturnType<typeof llmRankOptions>>, null | undefined>;
  options: ResolvedTargetOption[];
  effectivePolicy: ModelPolicyView | null;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): ProductTypeDecisionResult {
  const { llmResult, options, effectivePolicy, evidenceIds, supportingEvidenceIds, contradictingEvidenceIds } = input;
    const rawLabel = llmResult.values[0];
    const mappedId = mapRankedLabelToOptionExactlyOne(rawLabel, options);
    const resolvedId = mappedId ?? (effectivePolicy ? null : rawLabel);
    if (!resolvedId) {
      return {
        status: 'abstained',
        productTypeId: null,
        confidence: 0,
        selectedProbability: null,
        vendorConfidence: null,
        probabilityBasis: null,
        source: 'llm',
        abstentionCode: 'no_confident_match',
        abstentionReason: `LLM label "${rawLabel}" could not be unambiguously mapped to a configured product type ID.`,
        derivation: { kind: 'llm' },
        modelCallIds: llmResult.modelCallIds ?? [],
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      };
    }

    return {
      status: 'resolved',
      productTypeId: resolvedId,
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

async function executeProductTypeLegacyFallback(input: {
  target: ResolvedTarget;
  options: ResolvedTargetOption[];
  text: string;
  effectivePolicy: ModelPolicyView | null;
  snapshot: RuntimeClassificationSnapshot | null | undefined;
  runId: string;
  assertHeld?: () => void;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): Promise<ProductTypeDecisionResult> {
  const {
    target,
    options,
    text,
    effectivePolicy,
    snapshot,
    runId,
    assertHeld,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  } = input;
  const llmResult = await callProductTypeLegacyRanker({
    target,
    options,
    text,
    effectivePolicy,
    snapshot,
    runId,
    assertHeld,
  });
  return mapProductTypeLlmResult({
    llmResult,
    options,
    effectivePolicy,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  });
}

type ProductTypeJevPreparation =
  | { outcome: 'limited'; result: ProductTypeDecisionResult }
  | {
      outcome: 'ready';
      questionPlan: ProductTypeChoiceQuestionPlan;
      state: BoundedProductTypeState;
      request: { model: string; state: BoundedProductTypeState; questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }> };
      ctx: ModelCallContext;
      promptHash: string;
      callId: string;
      jevConn: unknown;
      startedAt: number;
    };

/**
 * Prepare one product-type Jev Choice request: limit guard, connection,
 * question, bounded state, audit context, and the durable start row.
 */
/**
 * Build the audit context for one product-type Jev call.
 */
function buildProductTypeCallContext(input: {
  runId: string;
  snapshot: RuntimeClassificationSnapshot | null | undefined;
}): ModelCallContext {
  const { runId, snapshot } = input;
  return {
    runId,
    snapshotHash: snapshot?.snapshotHash ?? '',
    stage: 'primary_product_type_proposal',
    operation: 'product_type_ranking',
    attempt: 1,
    promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS.product_type_ranking,
    ruleVersion: RULE_VERSIONS.product_type_ranking,
  };
}

function prepareProductTypeJevRequest(input: {
  options: ResolvedTargetOption[];
  evidence: ClassificationEvidence[];
  sku: string;
  runId: string;
  snapshot: RuntimeClassificationSnapshot | null | undefined;
  assertHeld?: () => void;
  route: ReturnType<typeof resolveModelRoute> | null;
  conn: any;
  effectivePolicy: ModelPolicyView | null;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): ProductTypeJevPreparation {
  const {
    options,
    evidence,
    sku,
    runId,
    snapshot,
    assertHeld,
    route,
    conn,
    effectivePolicy,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  } = input;
  // Option limit check: > 253 produces explicit limit abstention (no first-N clipping)
  if (options.length > MAX_ORDINARY_PRODUCT_TYPE_CANDIDATES) {
    return { outcome: 'limited', result: {
      status: 'abstained',
      productTypeId: null,
      confidence: 0,
      selectedProbability: null,
      vendorConfidence: null,
      probabilityBasis: 'choice_probability',
      source: 'jev',
      abstentionCode: 'candidate_limit_exceeded',
      abstentionReason: `candidate_limit_exceeded: Candidate Product Types (${options.length}) exceed maximum Choice capacity of ${MAX_ORDINARY_PRODUCT_TYPE_CANDIDATES}. First-N clipping is forbidden.`,
      derivation: buildChoiceJudgmentDerivation(JEV_PRODUCT_TYPE_QUESTION_ID, null, null, 'candidate_limit_exceeded'),
      modelCallIds: [],
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    } };
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

  // Build question and bounded state
  const questionPlan = buildProductTypeChoiceQuestion(options);
  const state = buildProductTypeState(evidence, sku);
  const ctx = buildProductTypeCallContext({ runId, snapshot });

  if (snapshot) {
    assertModelPlanCompatible(snapshot, 'product_type_ranking', ctx);
  }

  const opened = openSingleChoiceRequest({
    route,
    state,
    questionPlan,
    runId,
    ctx,
    effectivePolicyDigest: effectivePolicy.policyDigest,
    assertHeld,
  });
  return { outcome: 'ready', questionPlan, state, request: opened.request, ctx, promptHash: opened.promptHash, callId: opened.callId, jevConn, startedAt: opened.startedAt };
}

/**
 * Execute the TypeSafe Jev SystemOne Choice path: candidate-limit guard, frozen
 * request preparation, protected dispatch with audit rows, and interpretation.
 * Lease assertions and HeartbeatLost rethrow semantics are unchanged.
 */
/**
 * Run one prepared product-type Jev dispatch with audit completion and
 * answer interpretation. Dispatch failures surface as `service_failure`.
 */
/**
 * Record one failed product-type Jev dispatch (no post-loss writes on lease loss).
 */
function failProductTypeJevDispatch(input: {
  err: unknown;
  callId: string;
  startedAt: number;
  assertHeld?: () => void;
  questionPlan: ProductTypeChoiceQuestionPlan;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): ProductTypeDecisionResult {
  const { err, callId, startedAt, assertHeld, questionPlan, evidenceIds, supportingEvidenceIds, contradictingEvidenceIds } = input;
  if (err instanceof HeartbeatLostError) {
    // Lease lost: no post-loss writes, rethrow immediately
    throw err;
  }

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
    productTypeId: null,
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

async function runProductTypeJevDispatch(input: {
  jevConn: unknown;
  request: { model: string; state: unknown; questions: Record<string, { type: 'choice' | 'noul'; instructions: unknown; criteria?: unknown }> };
  questionPlan: ProductTypeChoiceQuestionPlan;
  callId: string;
  assertHeld?: () => void;
  startedAt: number;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): Promise<ProductTypeDecisionResult> {
  const {
    jevConn,
    request,
    questionPlan,
    callId,
    assertHeld,
    startedAt,
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
    interpret: ({ choiceKey, selectedProbability, vendorConfidence }) =>
      interpretProductTypeChoiceAnswer({
        choiceKey,
        selectedProbability,
        vendorConfidence,
        questionPlan,
        callId,
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      }),
    fail: (err) =>
      failProductTypeJevDispatch({
        err,
        callId,
        startedAt,
        assertHeld,
        questionPlan,
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      }),
  });
}

async function executeProductTypeJevChoice(input: {
  options: ResolvedTargetOption[];
  evidence: ClassificationEvidence[];
  sku: string;
  runId: string;
  snapshot: RuntimeClassificationSnapshot | null | undefined;
  assertHeld?: () => void;
  route: ReturnType<typeof resolveModelRoute> | null;
  conn: any;
  effectivePolicy: ModelPolicyView | null;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): Promise<ProductTypeDecisionResult> {
  const {
    options,
    evidence,
    sku,
    runId,
    snapshot,
    assertHeld,
    route,
    conn,
    effectivePolicy,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  } = input;
  const preparation = prepareProductTypeJevRequest({
    options,
    evidence,
    sku,
    runId,
    snapshot,
    assertHeld,
    route,
    conn,
    effectivePolicy,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  });
  if (preparation.outcome === 'limited') return preparation.result;
  const { questionPlan, request, callId, jevConn, startedAt } = preparation;

  return runProductTypeJevDispatch({
    jevConn,
    request,
    questionPlan,
    callId,
    assertHeld,
    startedAt,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  });
}

/**
 * Interpret one SystemOne Choice answer for product type: abstention outcomes,
 * canonical-id mapping, then the development-fitted 0.50 eligibility floor.
 * Unknown choice keys throw and surface as `service_failure` via the caller.
 */
function interpretProductTypeChoiceAnswer(input: {
  choiceKey: string;
  selectedProbability: number;
  vendorConfidence: number;
  questionPlan: ProductTypeChoiceQuestionPlan;
  callId: string;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): ProductTypeDecisionResult {
  const {
    choiceKey,
    selectedProbability,
    vendorConfidence,
    questionPlan,
    callId,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  } = input;
    // Evaluate against outcomes and calibrated eligibility policy
    if (choiceKey === NO_MATCH_CHOICE_KEY) {
      return {
        status: 'abstained',
        productTypeId: null,
        confidence: 0,
        selectedProbability,
        vendorConfidence,
        probabilityBasis: 'choice_probability',
        source: 'jev',
        abstentionCode: 'no_match',
        abstentionReason: 'no_fit: No matching product type in the configured taxonomy fits the product.',
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
        productTypeId: null,
        confidence: 0,
        selectedProbability,
        vendorConfidence,
        probabilityBasis: 'choice_probability',
        source: 'jev',
        abstentionCode: 'insufficient_evidence',
        abstentionReason: 'insufficient_evidence: Product evidence is insufficient to determine a product type with confidence.',
        derivation: buildChoiceJudgmentDerivation(questionPlan.questionId, selectedProbability, vendorConfidence, 'insufficient_evidence'),
        modelCallIds: [callId],
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      };
    }

    const canonicalId = choiceKeyToCanonicalId(questionPlan.keyToIdMap, choiceKey, 'option ID');

    // Check development-fitted eligibility floor (0.50)
    if (selectedProbability < JEV_PRODUCT_TYPE_MIN_PROBABILITY) {
      return {
        status: 'abstained',
        productTypeId: null,
        confidence: 0,
        selectedProbability,
        vendorConfidence,
        probabilityBasis: 'choice_probability',
        source: 'jev',
        abstentionCode: 'low_probability',
        abstentionReason: `low_probability: Selected product type "${canonicalId}" probability (${selectedProbability.toFixed(3)}) is below required threshold (${JEV_PRODUCT_TYPE_MIN_PROBABILITY}).`,
        derivation: buildChoiceJudgmentDerivation(questionPlan.questionId, selectedProbability, vendorConfidence, 'low_probability'),
        modelCallIds: [callId],
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      };
    }

    // Fully resolved!
    return {
      status: 'resolved',
      productTypeId: canonicalId,
      confidence: selectedProbability,
      selectedProbability,
      vendorConfidence,
      probabilityBasis: 'choice_probability',
      source: 'jev',
      derivation: buildChoiceJudgmentDerivation(questionPlan.questionId, selectedProbability, vendorConfidence),
      modelCallIds: [callId],
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    };
}

// ─── Canonical Decision Resolution ───────────────────────────────────────────

/**
 * Build the bounded evidence packet for grounding and deterministic matching.
 */
function buildProductTypeEvidencePacket(evidence: ClassificationEvidence[]): EvidenceTargetPacket {
  return buildEvidenceTargetPacket(evidence, {
    attributeId: null,
    sourceField: null,
    selectionMode: 'single',
    includeProductTypeContext: true,
    isGroundingSupport: tokenGroundingSupport,
  });
}

/**
 * Resolve the effective frozen model policy view (null when absent or malformed).
 */
function resolveProductTypeEffectivePolicy(
  modelPolicy: ModelPolicyView | null | undefined,
  snapshot: RuntimeClassificationSnapshot | null | undefined,
): ModelPolicyView | null {
  return asEffectivePolicyView(modelPolicy ?? snapshot?.modelPolicy ?? null);
}

/**
 * Build the terminal policy-denied result for product type (audit row + abstention).
 */
function buildProductTypePolicyDeniedResult(input: {
  err: ModelPolicyDeniedError;
  runId: string;
  snapshot: RuntimeClassificationSnapshot | null | undefined;
  effectivePolicy: ModelPolicyView;
  assertHeld?: () => void;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): ProductTypeDecisionResult {
  const {
    err,
    runId,
    snapshot,
    effectivePolicy,
    assertHeld,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  } = input;
  assertHeld?.();
  insertPolicyDeniedTerminalCall({
    runId,
    stageName: 'primary_product_type_proposal',
    operation: 'product_type_ranking',
    provider: err.provider ?? null,
    snapshotHash: snapshot?.snapshotHash ?? '',
    modelPolicyDigest: effectivePolicy.policyDigest,
    promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS.product_type_ranking,
    ruleVersion: RULE_VERSIONS.product_type_ranking,
    errorMessage: err.message,
  });
  return {
    status: 'abstained',
    productTypeId: null,
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

export async function resolveProductTypeDecision(
  params: ProductTypeDecisionParams,
): Promise<ProductTypeDecisionResult> {
  const { target, evidence, sku, runId, snapshot, modelPolicy, assertHeld } = params;
  assertHeld?.();
  const options = target.options;

  // 1. Build bounded evidence packet for grounding & deterministic match
  const packet = buildProductTypeEvidencePacket(evidence);

  const text = packet.promptText;
  const evidenceIds = packet.evidenceIds;
  const supportingEvidenceIds = packet.supportingEvidenceIds;
  const contradictingEvidenceIds = packet.contradictingEvidenceIds;

  const deterministic = checkProductTypeDeterministicMatch({
    options,
    text,
    packet,
    deterministicMatch: params.deterministicMatch,
    confidenceFloor: params.confidenceFloor,
  });
  if (deterministic) return deterministic;

  // 3. Resolve route through frozen model policy
  const effectivePolicy = resolveProductTypeEffectivePolicy(modelPolicy, snapshot);
  let route: ReturnType<typeof resolveModelRoute> | null = null;
  let conn: any = null;
  let isSystemOne = false;

  if (effectivePolicy) {
    try {
      const decision = resolveDecisionRouteForOperation(effectivePolicy, 'product_type_ranking');
      route = decision.route;
      conn = decision.conn;
      isSystemOne = decision.isSystemOne;
    } catch (err) {
      if (err instanceof HeartbeatLostError) throw err;
      if (err instanceof ModelPolicyDeniedError) {
        return buildProductTypePolicyDeniedResult({
          err,
          runId,
          snapshot,
          effectivePolicy,
          assertHeld,
          evidenceIds,
          supportingEvidenceIds,
          contradictingEvidenceIds,
        });
      }
      throw err;
    }
  }

  if (!isSystemOne) {
    // ── Legacy Chat LLM Fallback (OpenAI / Ollama / DeepSeek) ─────────────────
    return executeProductTypeLegacyFallback({
      target,
      options,
      text,
      effectivePolicy,
      snapshot,
      runId,
      assertHeld,
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    });
  }

  // ── TypeSafe Jev System One Choice Path ─────────────────────────────────────
  return executeProductTypeJevChoice({
    options,
    evidence,
    sku,
    runId,
    snapshot,
    assertHeld,
    route,
    conn,
    effectivePolicy,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  });
}
