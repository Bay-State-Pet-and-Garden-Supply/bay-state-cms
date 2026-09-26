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
  dispatchSystemOne,
  SYSTEMONE_MAX_CHOICE_OPTIONS,
  SYSTEMONE_MAX_ABSTENTION_RESERVED,
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
  type EvidenceTargetPacket,
} from './evidence-targeting';
import { matchKeywordOptions } from './curation-target-matcher';
import type { ResolvedTarget, ResolvedTargetOption } from './curation-target-resolver';
import type { ClassificationEvidence, ProposalDerivation } from '../shared/schemas/classification';
import { hashCanonicalJson } from '../shared/stable-id';

// ─── Versioned Constants ──────────────────────────────────────────────────────

export const PRODUCT_TYPE_JUDGMENT_VERSION = 'jev-choice-v1';
export const PRODUCT_TYPE_QUESTION_VERSION = 'product-type-question-v1';
export const PRODUCT_TYPE_ELIGIBILITY_VERSION = 'jev-pt-eligibility-v1';
export const PRODUCT_TYPE_STATE_VERSION = 'product-type-state-v1';

export const MAX_ORDINARY_PRODUCT_TYPE_CANDIDATES =
  SYSTEMONE_MAX_CHOICE_OPTIONS - SYSTEMONE_MAX_ABSTENTION_RESERVED; // 253

export const JEV_PRODUCT_TYPE_QUESTION_ID = 'primary_product_type';
export const NO_MATCH_CHOICE_KEY = 'no_match';
export const INSUFFICIENT_EVIDENCE_CHOICE_KEY = 'insufficient_evidence';

/**
 * Development-fitted minimum probability for Jev Choice selection.
 * Tuned on representative Pet & Garden assortment examples.
 * An ungrounded option pick below 0.50 probability is an explicit semantic abstention.
 */
export const JEV_PRODUCT_TYPE_MIN_PROBABILITY = 0.50;

export const KEYWORD_MATCH_MIN_CONFIDENCE = 0.7;

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

export interface BoundedProductTypeState {
  sku: string;
  name: string;
  brand: string | null;
  description: string | null;
  snippets: string[];
  attributes: Record<string, unknown>;
  evidenceCount: number;
}

/**
 * Builds bounded structured state from product evidence, capped at 32k bytes.
 */
export function buildProductTypeState(
  evidence: ClassificationEvidence[],
  sku: string,
): BoundedProductTypeState {
  let name = '';
  let brand: string | null = null;
  let description: string | null = null;
  const snippets: string[] = [];
  const attributes: Record<string, unknown> = {};

  for (const e of evidence) {
    const val = typeof e.value === 'string' ? e.value : (e.snippet ?? '');
    const sourceField = (e.sourceField ?? '').toLowerCase();

    if (!name && (sourceField.includes('name') || sourceField.includes('title'))) {
      name = val;
    } else if (!brand && (sourceField.includes('brand') || e.attributeId === 'brand')) {
      brand = typeof e.value === 'string' ? e.value : null;
    } else if (!description && sourceField.includes('description')) {
      description = val;
    } else if (e.snippet) {
      snippets.push(e.snippet);
    }

    if (e.attributeId && e.value != null) {
      attributes[e.attributeId] = e.value;
    }
  }

  const baseState: BoundedProductTypeState = {
    sku,
    name: name || sku,
    brand,
    description: description ? description.slice(0, 4000) : null,
    snippets: snippets.slice(0, 15).map(s => s.slice(0, 500)),
    attributes,
    evidenceCount: evidence.length,
  };

  // Ensure state serialization fits within SYSTEMONE_MAX_STATE_BYTES (32,768)
  const serialized = JSON.stringify(baseState);
  if (Buffer.byteLength(serialized, 'utf-8') > SYSTEMONE_MAX_STATE_BYTES) {
    baseState.snippets = baseState.snippets.slice(0, 5);
    if (baseState.description) {
      baseState.description = baseState.description.slice(0, 1000);
    }
  }

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

// ─── Canonical Decision Resolution ───────────────────────────────────────────

export async function resolveProductTypeDecision(
  params: ProductTypeDecisionParams,
): Promise<ProductTypeDecisionResult> {
  const { target, evidence, sku, runId, snapshot, modelPolicy, assertHeld } = params;
  assertHeld?.();
  const options = target.options;

  // 1. Build bounded evidence packet for grounding & deterministic match
  const packet: EvidenceTargetPacket = buildEvidenceTargetPacket(evidence, {
    attributeId: null,
    sourceField: null,
    selectionMode: 'single',
    includeProductTypeContext: true,
    isGroundingSupport: tokenGroundingSupport,
  });

  const text = packet.promptText;
  const evidenceIds = packet.evidenceIds;
  const supportingEvidenceIds = packet.supportingEvidenceIds;
  const contradictingEvidenceIds = packet.contradictingEvidenceIds;

  // 2. Deterministic matching precedence
  if (params.deterministicMatch && params.deterministicMatch.productTypeId !== null) {
    const match = params.deterministicMatch;
    const meetsFloor =
      params.confidenceFloor !== undefined ? (match.confidence ?? 0) >= params.confidenceFloor : true;
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
  } else if (options.length > 0 && text && text.length >= 3) {
    const keywordMatches = matchKeywordOptions({
      options,
      text,
      selectionMode: 'single',
    });
    if (keywordMatches.length > 0 && keywordMatches[0].confidence >= KEYWORD_MATCH_MIN_CONFIDENCE) {
      const top = keywordMatches[0];
      const meetsFloor =
        params.confidenceFloor !== undefined ? top.confidence >= params.confidenceFloor : true;
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

  // 3. Resolve route through frozen model policy
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
      const resolvedRoute = resolveModelRoute(effectivePolicy, 'product_type_ranking', {
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
          stageName: 'primary_product_type_proposal',
          operation: 'product_type_ranking',
          attempt: 1,
          provider: err.provider ?? null,
          model: null,
          locality: null,
          snapshotHash: snapshot?.snapshotHash ?? '',
          modelPolicyDigest: effectivePolicy.policyDigest,
          promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS.product_type_ranking,
          ruleVersion: RULE_VERSIONS.product_type_ranking,
          systemPromptHash: '',
          userPromptHash: '',
          status: MODEL_CALL_STATUS.policyDenied,
          errorMessage: err.message,
          costBasis: COST_BASIS.unknown,
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
      throw err;
    }
  }

  if (!isSystemOne) {
    // Post-qualification: Curation requires TypeSafe Jev (systemone transport).
    // Chat fallbacks are retired (Issue #312 / ADR 0033).
    assertHeld?.();
    insertTerminalModelCall({
      runId,
      stageName: 'primary_product_type_proposal',
      operation: 'product_type_ranking',
      attempt: 1,
      provider: route?.provider ?? null,
      model: route?.model ?? null,
      locality: route?.locality ?? null,
      snapshotHash: snapshot?.snapshotHash ?? '',
      modelPolicyDigest: effectivePolicy?.policyDigest ?? '',
      promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS.product_type_ranking,
      ruleVersion: RULE_VERSIONS.product_type_ranking,
      systemPromptHash: '',
      userPromptHash: '',
      status: MODEL_CALL_STATUS.unavailable,
      errorMessage: 'Classification chat fallback retired per issue #312 / ADR 0033. Route requires TypeSafe Jev (systemone transport).',
      costBasis: COST_BASIS.unknown,
    });
    return {
      status: 'abstained',
      productTypeId: null,
      confidence: 0,
      selectedProbability: null,
      vendorConfidence: null,
      probabilityBasis: null,
      source: 'jev',
      abstentionCode: 'service_failure',
      abstentionReason: 'Model-backed product type ranking requires TypeSafe Jev. Superseded chat classifiers are retired per ADR 0033.',
      derivation: { kind: 'model_choice' },
      modelCallIds: [],
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    };
  }

  // ── TypeSafe Jev System One Choice Path ─────────────────────────────────────

  // Option limit check: > 253 produces explicit limit abstention (no first-N clipping)
  if (options.length > MAX_ORDINARY_PRODUCT_TYPE_CANDIDATES) {
    return {
      status: 'abstained',
      productTypeId: null,
      confidence: 0,
      selectedProbability: null,
      vendorConfidence: null,
      probabilityBasis: 'choice_probability',
      source: 'jev',
      abstentionCode: 'candidate_limit_exceeded',
      abstentionReason: `candidate_limit_exceeded: Candidate Product Types (${options.length}) exceed maximum Choice capacity of ${MAX_ORDINARY_PRODUCT_TYPE_CANDIDATES}. First-N clipping is forbidden.`,
      derivation: {
        kind: 'systemone_judgment',
        primitive: 'choice',
        questionId: JEV_PRODUCT_TYPE_QUESTION_ID,
        selectedProbability: null,
        vendorConfidence: null,
        probabilityBasis: 'choice_probability',
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

  // Build question and bounded state
  const questionPlan = buildProductTypeChoiceQuestion(options);
  const state = buildProductTypeState(evidence, sku);

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

  // Lease assertion before audit start
  assertHeld?.();

  const ctx: ModelCallContext = {
    runId,
    snapshotHash: snapshot?.snapshotHash ?? '',
    stage: 'primary_product_type_proposal',
    operation: 'product_type_ranking',
    attempt: 1,
    promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS.product_type_ranking,
    ruleVersion: RULE_VERSIONS.product_type_ranking,
  };

  if (snapshot) {
    assertModelPlanCompatible(snapshot, 'product_type_ranking', ctx);
  }

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

    if (result.returnedModel !== request.model) {
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

    // Record complete durable call
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
        productTypeId: null,
        confidence: 0,
        selectedProbability,
        vendorConfidence,
        probabilityBasis: 'choice_probability',
        source: 'jev',
        abstentionCode: 'insufficient_evidence',
        abstentionReason: 'insufficient_evidence: Product evidence is insufficient to determine a product type with confidence.',
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

    const canonicalId = questionPlan.keyToIdMap.get(choiceKey);
    if (!canonicalId) {
      throw new Error(`Returned choice key "${choiceKey}" does not map to any canonical option ID.`);
    }

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

    // Fully resolved!
    return {
      status: 'resolved',
      productTypeId: canonicalId,
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
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    };
  } catch (err) {
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
