/**
 * Canonical Category Page Decision Boundary (Issue #299 / ADR 0033).
 *
 * Single internal canonical-decision boundary for Category Page classification,
 * supporting singleton page curation via TypeSafe Jev System One.
 *
 * Enforces:
 * - Deterministic matching and reviewed facts retain precedence.
 * - Effective reviewed Primary Product Type authority required.
 * - Verified Page catalog required from frozen snapshot.
 * - Frozen canonical Page identities and hierarchy context used, never names as assignment identity.
 * - Single mode: Choice over eligible verified pages plus explicit `no_match` and `insufficient_evidence` outcomes.
 * - Multiple mode: One Noul per eligible verified page with independent P(yes) probabilities.
 * - Candidate limit checks (>253 produces candidate_limit_exceeded without clipping in single mode).
 * - Bounded requests: batches of <= 32 questions for multiple mode, fail-closed on incomplete batches.
 * - Preserves deterministic rules: specificity (Shop All suppression), brand-page shortcut (isBrandShortcut: true),
 *   species safety, max-count limits, and category correctness validation.
 * - Restricted page evidence packets reused (no unrelated claims or broad run evidence).
 * - Stored selected probability and vendor concentration confidence separated with explicit basis.
 * - Development-fitted threshold (0.50 floor for single, 0.70 for multiple); no clamps or probability boosting.
 * - Protected execution with audit rows in `classification_model_calls` and lease assertions.
 * - Non-bulk-acceptable proposals (isBulkAcceptable: false) for Jev proposals.
 * - Fallback to existing chat LLM assigner when provider is openai-compatible/ollama-native.
 */

import { randomUUID } from 'node:crypto';
import {
  dispatchSystemOne,
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
  buildPageEvidencePacket,
} from './evidence-targeting';
import {
  buildPageHierarchy,
  extractProductContext,
  llmAssignCategoryPages,
  normalizePageAssignments,
} from './page-assignment-llm';
import { validateCategoryPageAssignment } from './category-page-correctness';
import { buildCategoryPageProposal } from './curation-target-proposal';
import type { ResolvedTarget } from './curation-target-resolver';
import type { ClassificationEvidence, ClassificationProposal, ProposalDerivation } from '../shared/schemas/classification';
import { hashCanonicalJson } from '../shared/stable-id';
import type { ProtectedOperation } from './model-operation-registry';

// ─── Versioned Constants ──────────────────────────────────────────────────────

export const PAGE_JUDGMENT_VERSION = 'jev-page-v1';
export const PAGE_QUESTION_VERSION = 'page-question-v1';
export const PAGE_ELIGIBILITY_VERSION = 'jev-page-eligibility-v1';
export const PAGE_STATE_VERSION = 'page-state-v1';

export const JEV_PAGE_QUESTION_ID = 'category_page_assignment';
export const MAX_ORDINARY_PAGE_CANDIDATES =
  SYSTEMONE_MAX_CHOICE_OPTIONS - SYSTEMONE_MAX_ABSTENTION_RESERVED; // 253

export const JEV_PAGE_SINGLE_THRESHOLD = 0.50;
export const JEV_PAGE_MULTI_THRESHOLD = 0.70;
export const JEV_PAGE_MULTI_UNCERTAIN_FLOOR = 0.40;

export const NO_MATCH_CHOICE_KEY = 'abstain_no_match';
export const INSUFFICIENT_EVIDENCE_CHOICE_KEY = 'abstain_insufficient_evidence';

export const PAGE_CONTEXT_SOURCE_FIELDS = [
  'name',
  'title',
  'description',
  'page_name',
  'category',
  'species',
  'productForm',
  'productType',
  'brand',
  'resolved_brand',
];
export const PAGE_CONTEXT_ATTRIBUTE_IDS = ['species', 'brand'];

const now = () => new Date().toISOString();

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PageCandidateItem {
  pageId: string;
  pageName: string;
  parentId: string | null;
  parentName: string | null;
  path: string;
}

export interface PageDecisionProductContext {
  productName?: string;
  productDescription?: string;
  productType?: string | null;
  ocrSummary?: {
    species?: string[];
    flavor?: string | null;
    lifeStage?: string | null;
    productForm?: string | null;
    healthConcern?: string[];
    productName?: string | null;
    brand?: string | null;
  };
}

export interface PageCandidateProposal {
  pageId: string;
  pageName: string;
  confidence: number;
  selectedProbability?: number;
  vendorConfidence?: number | null;
  probabilityBasis?: string;
  isBrandShortcut?: boolean;
}

export interface PageDecisionResult {
  outcome: 'predicted' | 'abstained' | 'failed';
  status: 'succeeded' | 'abstained' | 'failed';
  pages: PageCandidateProposal[];
  selectedProbability?: number | null;
  vendorConfidence?: number | null;
  probabilityBasis?: string | null;
  candidateProbabilities?: Record<string, number>;
  source: 'jev' | 'llm' | 'deterministic';
  abstentionCode?: string | null;
  abstentionReason?: string | null;
  failureCode?: string | null;
  modelCallIds: string[];
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  derivation?: ProposalDerivation;
}

export interface ResolvePageDecisionParams {
  target: ResolvedTarget;
  evidence: ClassificationEvidence[];
  sku: string;
  runId: string;
  snapshot?: RuntimeClassificationSnapshot | null;
  modelPolicy?: ModelPolicyView | null;
  assertHeld?: () => void;
  selectionMode?: 'single' | 'multiple';
  maxPages?: number;
  productContext?: PageDecisionProductContext;
  reviewedProductTypeId?: string | null;
  protectedOperation?: ProtectedOperation;
}

// ─── Helper Functions ─────────────────────────────────────────────────────────

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

function reviewedSpeciesValue(evidence: ClassificationEvidence[]): unknown {
  const speciesRecord = evidence.find(
    e => (e.attributeId === 'species' || e.sourceField === 'species') && e.value != null,
  );
  return speciesRecord?.value ?? undefined;
}

/**
 * Build bounded state specifically for Category Page decisions.
 * Restricted to page-evidence packet records (never unrelated claims or full runs).
 */
export function buildPageState(
  evidence: ClassificationEvidence[],
  sku: string,
  productContext?: PageDecisionProductContext,
): Record<string, unknown> {
  const evidenceRecords = evidence
    .slice()
    .sort((a, b) => (a.id ?? '').localeCompare(b.id ?? ''))
    .map(e => ({
      source: e.source,
      sourceField: e.sourceField ?? null,
      value: typeof e.value === 'string' ? e.value.slice(0, 500) : e.value,
      snippet: typeof e.snippet === 'string' ? e.snippet.slice(0, 500) : null,
      reliability: e.reliability,
    }));

  const baseState: Record<string, unknown> = {
    sku,
    productName: productContext?.productName ?? null,
    productDescription: productContext?.productDescription ? productContext.productDescription.slice(0, 1000) : null,
    productType: productContext?.productType ?? null,
    species: productContext?.ocrSummary?.species ?? null,
    brand: productContext?.ocrSummary?.brand ?? null,
    evidenceCount: evidenceRecords.length,
    evidenceRecords,
  };

  const serialized = JSON.stringify(baseState);
  if (Buffer.byteLength(serialized, 'utf-8') > SYSTEMONE_MAX_STATE_BYTES) {
    baseState.evidenceRecords = evidenceRecords.slice(0, 5);
  }

  return baseState;
}

export interface PageChoiceQuestionPlan {
  questionId: string;
  instructions: string;
  criteria: Record<string, string>;
  keyToIdMap: Map<string, string>;
  idToKeyMap: Map<string, string>;
}

export function buildPageChoiceQuestion(
  candidates: PageCandidateItem[],
  productType?: string | null,
): PageChoiceQuestionPlan {
  const keyToIdMap = new Map<string, string>();
  const idToKeyMap = new Map<string, string>();
  const criteria: Record<string, string> = {};

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const key = `page_opt_${i}`;
    keyToIdMap.set(key, cand.pageId);
    idToKeyMap.set(cand.pageId, key);
    criteria[key] = `${cand.pageName} (Path: "${cand.path}")`;
  }

  // Two dedicated abstention outcomes
  criteria[NO_MATCH_CHOICE_KEY] =
    'None of the specific store category pages listed above apply to this product.';
  criteria[INSUFFICIENT_EVIDENCE_CHOICE_KEY] =
    'The product evidence is insufficient, ambiguous, or lacks essential product details to determine the category page with confidence.';

  const typeDesc = productType ? `"${productType}"` : 'product';
  const instructions =
    `Select the single most specific and appropriate store category page for this ${typeDesc} from the eligible catalog choices based strictly on the provided product evidence. If none of the specific options apply, select "${NO_MATCH_CHOICE_KEY}". If the evidence does not provide enough information to determine the page with confidence, select "${INSUFFICIENT_EVIDENCE_CHOICE_KEY}".`;

  return {
    questionId: JEV_PAGE_QUESTION_ID,
    instructions,
    criteria,
    keyToIdMap,
    idToKeyMap,
  };
}

export interface PageNoulQuestionPlan {
  questionId: string;
  pageId: string;
  pageName: string;
  candidateIndex: number;
  instructions: string;
  criteria: { true: string; false: string };
}

export function buildPageNoulQuestions(
  candidates: PageCandidateItem[],
  sku: string,
  productContext?: PageDecisionProductContext,
): PageNoulQuestionPlan[] {
  const name = productContext?.productName || sku;

  return candidates.map((cand, i) => {
    const cleanId = cand.pageId.replace(/[^A-Za-z0-9_.-]/g, '_');
    const questionId = `page_${cleanId}__${i}`;
    const instructions = `Does the product "${name}" (SKU ${sku}) belong on the store category page "${cand.pageName}" (Path: "${cand.path}") based directly on the provided evidence?`;
    const criteria = {
      true: `The product evidence directly and clearly indicates that the product belongs on the "${cand.pageName}" category page according to store taxonomy, assortment, and species rules.`,
      false: `The product does not belong on the "${cand.pageName}" page, or a different category page is more specific or appropriate.`,
    };
    return {
      questionId,
      pageId: cand.pageId,
      pageName: cand.pageName,
      candidateIndex: i,
      instructions,
      criteria,
    };
  });
}

// ─── Canonical Decision Resolution ───────────────────────────────────────────

export async function resolvePageDecision(
  params: ResolvePageDecisionParams,
): Promise<PageDecisionResult> {
  const {
    target,
    evidence,
    sku,
    runId,
    snapshot,
    modelPolicy,
    assertHeld,
    selectionMode = 'multiple',
    maxPages = selectionMode === 'multiple' ? 5 : 1,
    reviewedProductTypeId,
    protectedOperation = 'page_assignment',
  } = params;

  assertHeld?.();

  // 1. Gating rule: Product Type authority prerequisite
  // Page proposals require a reviewed Primary Product Type whenever product_type is an enabled target.
  const hasProductTypeTarget = snapshot?.curationTargets?.some(
    t => t.kind === 'product_type' && (t.enabled || t.mandatory),
  ) ?? false;

  if (hasProductTypeTarget && (reviewedProductTypeId === null || reviewedProductTypeId === undefined || reviewedProductTypeId === '')) {
    return {
      outcome: 'abstained',
      status: 'abstained',
      pages: [],
      selectedProbability: null,
      vendorConfidence: null,
      probabilityBasis: null,
      source: 'deterministic',
      abstentionCode: 'no_reviewed_product_type',
      abstentionReason: 'No reviewed Primary Product Type. Page assignment requires an accepted Product Type and a verified Page catalog.',
      modelCallIds: [],
      evidenceIds: [],
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
    };
  }

  // 2. Gating rule: Verified store pages catalog prerequisite
  const verifiedRecords = snapshot?.pages.state === 'verified' ? snapshot.pages.records : [];
  if (!snapshot || snapshot.pages.state !== 'verified' || !target.options || target.options.length === 0 || verifiedRecords.length === 0) {
    return {
      outcome: 'abstained',
      status: 'abstained',
      pages: [],
      selectedProbability: null,
      vendorConfidence: null,
      probabilityBasis: null,
      source: 'deterministic',
      abstentionCode: 'no_verified_pages',
      abstentionReason: 'No verified store pages available. Page assignment requires a verified ShopSite Pages import.',
      modelCallIds: [],
      evidenceIds: [],
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
    };
  }

  // Build page hierarchy purely over frozen verified snapshot records
  const rawHierarchy = buildPageHierarchy(target.options, verifiedRecords);
  const candidates: PageCandidateItem[] = rawHierarchy.map(p => ({
    pageId: p.id,
    pageName: p.name,
    parentId: verifiedRecords.find(r => r.pageId === p.id)?.parentPageId ?? null,
    parentName: p.parentName,
    path: p.parentName ? `${p.parentName} > ${p.name}` : p.name,
  }));

  // Build restricted page-evidence packet
  const speciesVal = reviewedSpeciesValue(evidence);
  const pagePacket = buildPageEvidencePacket(evidence, {
    pageContextSourceFields: PAGE_CONTEXT_SOURCE_FIELDS,
    pageContextAttributeIds: PAGE_CONTEXT_ATTRIBUTE_IDS,
    sourceField: null,
    speciesValue: speciesVal,
  });

  const evidenceIds = pagePacket.evidenceIds;
  const supportingEvidenceIds = pagePacket.supportingEvidenceIds;
  const contradictingEvidenceIds = pagePacket.contradictingEvidenceIds;

  // Extract structured product context from restricted packet
  const pageContextEvidence = [
    ...pagePacket.supporting,
    ...pagePacket.contradicting,
    ...pagePacket.context,
  ].sort((a, b) => (a.id ?? '').localeCompare(b.id ?? ''));

  const extractedContext = extractProductContext(pageContextEvidence, []);
  const productContext: PageDecisionProductContext = {
    productName: params.productContext?.productName ?? extractedContext.productName,
    productDescription: params.productContext?.productDescription ?? extractedContext.productDescription,
    productType: params.productContext?.productType ?? reviewedProductTypeId ?? extractedContext.productType,
    ocrSummary: params.productContext?.ocrSummary ?? extractedContext.ocrSummary,
  };

  // 3. Resolve Model Policy Route
  const rawPolicy = modelPolicy ?? (snapshot ? snapshot.modelPolicy : null);
  const effectivePolicy: ModelPolicyView | null =
    rawPolicy && typeof rawPolicy === 'object' && 'policyDigest' in rawPolicy && 'providerLocalities' in rawPolicy
      ? (rawPolicy as ModelPolicyView)
      : null;

  let route: ReturnType<typeof resolveModelRoute> | null = null;
  let conn: any = null;
  let isSystemOne = false;

  if (effectivePolicy) {
    try {
      assertModelPolicyIntact(effectivePolicy);
      const resolvedRoute = resolveModelRoute(effectivePolicy, protectedOperation, {
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
          stageName: 'category_page_proposals',
          operation: protectedOperation,
          attempt: 1,
          provider: err.provider ?? null,
          model: null,
          locality: null,
          snapshotHash: snapshot?.snapshotHash ?? '',
          modelPolicyDigest: effectivePolicy.policyDigest,
          promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS[protectedOperation],
          ruleVersion: RULE_VERSIONS[protectedOperation],
          systemPromptHash: '',
          userPromptHash: '',
          status: MODEL_CALL_STATUS.policyDenied,
          errorMessage: err.message,
          costBasis: COST_BASIS.unknown,
        });
        return {
          outcome: 'abstained',
          status: 'abstained',
          pages: [],
          selectedProbability: null,
          vendorConfidence: null,
          probabilityBasis: null,
          source: 'deterministic',
          abstentionCode: 'policy_denied',
          abstentionReason: `Model policy denied: ${err.message}`,
          modelCallIds: [],
          evidenceIds,
          supportingEvidenceIds,
          contradictingEvidenceIds,
        };
      }
      throw err;
    }
  }

  // 4. Fallback to existing chat LLM assigner if not routed to SystemOne
  if (!isSystemOne) {
    const llmResult = await llmAssignCategoryPages({
      productName: productContext.productName ?? 'Unknown Product',
      productDescription: productContext.productDescription ?? '',
      ocrSummary: {
        species: productContext.ocrSummary?.species ?? [],
        flavor: productContext.ocrSummary?.flavor ?? null,
        lifeStage: productContext.ocrSummary?.lifeStage ?? null,
        productForm: productContext.ocrSummary?.productForm ?? null,
        healthConcern: productContext.ocrSummary?.healthConcern ?? [],
        productName: productContext.ocrSummary?.productName ?? null,
        brand: productContext.ocrSummary?.brand ?? null,
      },
      productType: productContext.productType ?? null,
      pages: rawHierarchy,
      selectionMode,
      maxPages,
      modelPolicy: effectivePolicy,
      snapshot,
    });

    if (!llmResult || llmResult.pages.length === 0) {
      return {
        outcome: 'abstained',
        status: 'abstained',
        pages: [],
        selectedProbability: null,
        vendorConfidence: null,
        probabilityBasis: null,
        source: 'llm',
        abstentionCode: 'no_match',
        abstentionReason: 'No category page matches found from LLM.',
        modelCallIds: llmResult?.modelCallIds ?? [],
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      };
    }

    return {
      outcome: 'predicted',
      status: 'succeeded',
      pages: llmResult.pages.map(p => ({
        pageId: p.pageId,
        pageName: p.pageName,
        confidence: p.confidence,
        isBrandShortcut: p.isBrandShortcut,
      })),
      selectedProbability: llmResult.pages[0]?.confidence ?? 0.55,
      vendorConfidence: null,
      probabilityBasis: 'llm_ranker',
      source: 'llm',
      modelCallIds: llmResult.modelCallIds ?? [],
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    };
  }

  // ── TypeSafe Jev System One Execution ───────────────────────────────────────

  if (!route || !effectivePolicy) {
    throw new Error('System One route or effective policy was not resolved.');
  }

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
  assertHeld?.();

  // Bounded state from restricted page evidence packet records only
  const state = buildPageState(pageContextEvidence, sku, productContext);

  const ctx: ModelCallContext = {
    runId,
    snapshotHash: snapshot?.snapshotHash ?? '',
    stage: 'category_page_proposals',
    operation: protectedOperation,
    attempt: 1,
    promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS[protectedOperation],
    ruleVersion: RULE_VERSIONS[protectedOperation],
  };

  if (snapshot) {
    assertModelPlanCompatible(snapshot, protectedOperation, ctx);
  }

  const pageIndex = new Map(rawHierarchy.map(p => [p.name, { id: p.id, name: p.name }]));
  const resolvedBrand = productContext.ocrSummary?.brand ?? null;
  const productSpecies = productContext.ocrSummary?.species ?? [];

  // ── Single-Mode Choice Execution ───────────────────────────────────────────
  if (selectionMode === 'single') {
    if (candidates.length > MAX_ORDINARY_PAGE_CANDIDATES) {
      return {
        outcome: 'abstained',
        status: 'abstained',
        pages: [],
        selectedProbability: null,
        vendorConfidence: null,
        probabilityBasis: 'choice_probability',
        source: 'jev',
        abstentionCode: 'candidate_limit_exceeded',
        abstentionReason: `candidate_limit_exceeded: Candidate Category Pages (${candidates.length}) exceed maximum Choice capacity of ${MAX_ORDINARY_PAGE_CANDIDATES}. First-N clipping is forbidden.`,
        derivation: {
          kind: 'systemone_judgment',
          primitive: 'choice',
          questionId: JEV_PAGE_QUESTION_ID,
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

    const questionPlan = buildPageChoiceQuestion(candidates, productContext.productType);
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
    let result: any;

    try {
      assertHeld?.();
      result = await dispatchSystemOne(jevConn as any, request);
      assertHeld?.();

      if (result.returnedModel !== request.model) {
        throw new Error(`Model mismatch: requested model "${request.model}", but provider returned "${result.returnedModel}". Pinned model substitution is forbidden.`);
      }

      const durationMs = Date.now() - startedAt;
      const answer = result.answers[questionPlan.questionId];

      if (!answer || answer.type !== 'choice') {
        throw new Error(`Expected choice answer for question "${questionPlan.questionId}", got "${answer?.type ?? 'missing'}".`);
      }

      const chosenKey = answer.choice;
      const selectedProbability = answer.probabilities[chosenKey] ?? 0;
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
          choice: chosenKey,
          canonicalId: questionPlan.keyToIdMap.get(chosenKey) ?? null,
          resolvedId: questionPlan.keyToIdMap.get(chosenKey) ?? null,
          selectedProbability,
          vendorConfidence,
          basis: 'choice_probability',
        },
      });

      // Check semantic abstention outcomes
      if (chosenKey === NO_MATCH_CHOICE_KEY) {
        return {
          outcome: 'abstained',
          status: 'abstained',
          pages: [],
          selectedProbability,
          vendorConfidence,
          probabilityBasis: 'choice_probability',
          source: 'jev',
          abstentionCode: 'no_match',
          abstentionReason: 'no_match: No matching Category Page in the catalog applies to this product.',
          derivation: {
            kind: 'systemone_judgment',
            primitive: 'choice',
            questionId: JEV_PAGE_QUESTION_ID,
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

      if (chosenKey === INSUFFICIENT_EVIDENCE_CHOICE_KEY) {
        return {
          outcome: 'abstained',
          status: 'abstained',
          pages: [],
          selectedProbability,
          vendorConfidence,
          probabilityBasis: 'choice_probability',
          source: 'jev',
          abstentionCode: 'insufficient_evidence',
          abstentionReason: 'insufficient_evidence: Product evidence is insufficient to determine the correct Category Page.',
          derivation: {
            kind: 'systemone_judgment',
            primitive: 'choice',
            questionId: JEV_PAGE_QUESTION_ID,
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
    } catch (err: any) {
      if (err instanceof HeartbeatLostError) throw err;
      assertHeld?.();
      const latencyMs = Date.now() - startedAt;
      completeModelCall(callId, {
        status: MODEL_CALL_STATUS.failed,
        endedAt: now(),
        costBasis: COST_BASIS.unknown,
        errorMessage: err instanceof Error ? err.message : String(err),
        durationMs: latencyMs,
      });

      return {
        outcome: 'failed',
        status: 'failed',
        pages: [],
        selectedProbability: null,
        vendorConfidence: null,
        probabilityBasis: null,
        source: 'jev',
        failureCode: 'service_failure',
        abstentionCode: 'service_failure',
        abstentionReason: `TypeSafe Jev dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        modelCallIds: [callId],
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      };
    }

    const answer = result.answers[questionPlan.questionId];
    const chosenKey = answer.choice;
    const selectedProbability = answer.probabilities[chosenKey] ?? 0;
    const vendorConfidence = answer.confidence;

    const pageId = questionPlan.keyToIdMap.get(chosenKey);
    const candidate = candidates.find(c => c.pageId === pageId);

    if (!pageId || !candidate) {
      return {
        outcome: 'failed',
        status: 'failed',
        pages: [],
        selectedProbability,
        vendorConfidence,
        probabilityBasis: 'choice_probability',
        source: 'jev',
        failureCode: 'unknown_option_key',
        abstentionCode: 'unknown_option_key',
        abstentionReason: `Selected choice key "${chosenKey}" could not be mapped to a known candidate page.`,
        modelCallIds: [callId],
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      };
    }

    // Single mode threshold check (0.50 floor)
    if (selectedProbability < JEV_PAGE_SINGLE_THRESHOLD) {
      return {
        outcome: 'abstained',
        status: 'abstained',
        pages: [],
        selectedProbability,
        vendorConfidence,
        probabilityBasis: 'choice_probability',
        source: 'jev',
        abstentionCode: 'insufficient_evidence',
        abstentionReason: `insufficient_evidence: Selected category page probability ${selectedProbability.toFixed(3)} is below required threshold ${JEV_PAGE_SINGLE_THRESHOLD.toFixed(2)}.`,
        derivation: {
          kind: 'systemone_judgment',
          primitive: 'choice',
          questionId: JEV_PAGE_QUESTION_ID,
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

    // Apply deterministic normalizations
    const initialPages = [{
      pageId: candidate.pageId,
      pageName: candidate.pageName,
      confidence: selectedProbability,
      isBrandShortcut: false,
    }];

    const normalizedPages = normalizePageAssignments(
      initialPages,
      pageIndex,
      resolvedBrand,
      productSpecies,
      1,
      'single',
    );

    if (normalizedPages.length === 0) {
      return {
        outcome: 'abstained',
        status: 'abstained',
        pages: [],
        selectedProbability,
        vendorConfidence,
        probabilityBasis: 'choice_probability',
        source: 'jev',
        abstentionCode: 'species_conflict',
        abstentionReason: 'Proposed category page filtered out by deterministic rules (e.g. cross-species conflict).',
        derivation: {
          kind: 'systemone_judgment',
          primitive: 'choice',
          questionId: JEV_PAGE_QUESTION_ID,
          selectedProbability,
          vendorConfidence,
          probabilityBasis: 'choice_probability',
          abstentionCode: 'species_conflict',
        },
        modelCallIds: [callId],
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      };
    }

    // Category correctness validation
    const correctnessResult = validateCategoryPageAssignment({
      member: {
        onboardingItemId: sku,
        frozenEvidenceHash: snapshot?.snapshotHash ?? '',
        frozenEvidence: {
          species: productSpecies,
          productType: productContext.productType,
          title: productContext.productName ?? null,
          description: productContext.productDescription ?? null,
          brand: resolvedBrand,
        },
        frozenProductTypeContext: productContext.productType,
      },
      candidate: {
        primaryPageId: normalizedPages[0].pageId,
        secondaryPageIds: [],
        primaryPageName: normalizedPages[0].pageName,
      },
      verifiedPageCatalog: verifiedRecords.map(r => ({
        id: r.pageId,
        name: r.pageName,
        parentId: r.parentPageId ?? null,
      })),
      activePageImportHash: snapshot?.snapshotHash ?? '',
    });

    if (correctnessResult.outcome === 'blocked' || !correctnessResult.valid) {
      return {
        outcome: 'abstained',
        status: 'abstained',
        pages: [],
        selectedProbability,
        vendorConfidence,
        probabilityBasis: 'choice_probability',
        source: 'jev',
        abstentionCode: 'validation_blocked',
        abstentionReason: correctnessResult.reason ?? 'Category page validation failed.',
        derivation: {
          kind: 'systemone_judgment',
          primitive: 'choice',
          questionId: JEV_PAGE_QUESTION_ID,
          selectedProbability,
          vendorConfidence,
          probabilityBasis: 'choice_probability',
          abstentionCode: 'validation_blocked',
        },
        modelCallIds: [callId],
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      };
    }

    return {
      outcome: 'predicted',
      status: 'succeeded',
      pages: normalizedPages.map(p => ({
        ...p,
        selectedProbability,
        vendorConfidence,
        probabilityBasis: 'choice_probability',
      })),
      selectedProbability,
      vendorConfidence,
      probabilityBasis: 'choice_probability',
      source: 'jev',
      modelCallIds: [callId],
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
      derivation: {
        kind: 'systemone_judgment',
        primitive: 'choice',
        questionId: JEV_PAGE_QUESTION_ID,
        selectedProbability,
        vendorConfidence,
        probabilityBasis: 'choice_probability',
      },
    };
  }

  // Exclude brand landing pages from Noul questions in multiple mode, as they are resolved
  // deterministically via brand-page shortcut rules and separated in provenance.
  const eligibleCandidates = candidates.filter(c => !c.pageName.toLowerCase().startsWith('brand -'));
  const noulQuestions = buildPageNoulQuestions(eligibleCandidates, sku, productContext);
  const candidateProbabilities: Record<string, number> = {};
  const modelCallIds: string[] = [];
  const evaluations: Array<{ pageId: string; pageName: string; prob: number; candidateIndex: number }> = [];

  // Bounded batches: at most SYSTEMONE_MAX_QUESTIONS (32) questions per call
  for (let offset = 0; offset < noulQuestions.length; offset += SYSTEMONE_MAX_QUESTIONS) {
    assertHeld?.();
    const batch = noulQuestions.slice(offset, offset + SYSTEMONE_MAX_QUESTIONS);
    const request = {
      model: route.model || TYPESAFE_EVALUATED_MODEL,
      state,
      questions: Object.fromEntries(
        batch.map(q => [
          q.questionId,
          {
            type: 'noul' as const,
            instructions: q.instructions,
            criteria: q.criteria,
          },
        ]),
      ),
    };

    const promptHash = hashCanonicalJson(request);

    const callId = insertModelCallStart({
      runId,
      stageName: ctx.stage,
      operation: ctx.operation,
      attempt: 1,
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
    let result: any;

    try {
      assertHeld?.();
      result = await dispatchSystemOne(jevConn as any, request);
      assertHeld?.();

      if (result.returnedModel !== request.model) {
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
          batchedQuestions: Object.keys(request.questions),
          resolvedModel: result.returnedModel,
          basis: 'noul_probability',
        },
      });

      for (const q of batch) {
        const answer = result.answers[q.questionId];
        if (!answer || answer.type !== 'noul') {
          throw new Error(`Expected noul answer for question "${q.questionId}", got "${answer?.type ?? 'missing'}".`);
        }
        const pYes = answer.noul;
        candidateProbabilities[q.pageId] = pYes;
        evaluations.push({
          pageId: q.pageId,
          pageName: q.pageName,
          prob: pYes,
          candidateIndex: q.candidateIndex,
        });
      }
    } catch (err: any) {
      if (err instanceof HeartbeatLostError) throw err;
      assertHeld?.();
      const latencyMs = Date.now() - startedAt;
      completeModelCall(callId, {
        status: MODEL_CALL_STATUS.failed,
        endedAt: now(),
        costBasis: COST_BASIS.unknown,
        errorMessage: err instanceof Error ? err.message : String(err),
        durationMs: latencyMs,
      });

      return {
        outcome: 'failed',
        status: 'failed',
        pages: [],
        selectedProbability: null,
        vendorConfidence: null,
        probabilityBasis: null,
        source: 'jev',
        failureCode: 'service_failure',
        abstentionCode: 'service_failure',
        abstentionReason: `TypeSafe Jev dispatch failed on batch: ${err instanceof Error ? err.message : String(err)}`,
        modelCallIds,
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      };
    }
  }

  // Evaluate multiple-page selection policy
  let qualifying = evaluations.filter(e => e.prob >= JEV_PAGE_MULTI_THRESHOLD);

  if (qualifying.length === 0) {
    const maxP = Math.max(...evaluations.map(e => e.prob), 0);
    const code = maxP < JEV_PAGE_MULTI_UNCERTAIN_FLOOR ? 'no_match' : 'insufficient_evidence';
    const reason = maxP < JEV_PAGE_MULTI_UNCERTAIN_FLOOR
      ? 'no_match: No Category Page in the catalog applies to this product with sufficient confidence.'
      : `insufficient_evidence: Product evidence is insufficient to assign Category Pages with confidence (highest probability ${maxP.toFixed(3)} is below threshold ${JEV_PAGE_MULTI_THRESHOLD.toFixed(2)}).`;

    return {
      outcome: 'abstained',
      status: 'abstained',
      pages: [],
      selectedProbability: maxP > 0 ? maxP : null,
      vendorConfidence: null,
      probabilityBasis: 'noul_probability',
      candidateProbabilities,
      source: 'jev',
      abstentionCode: code,
      abstentionReason: reason,
      derivation: {
        kind: 'systemone_judgment',
        primitive: 'noul',
        questionId: JEV_PAGE_QUESTION_ID,
        selectedProbability: maxP > 0 ? maxP : null,
        vendorConfidence: null,
        probabilityBasis: 'noul_probability',
        abstentionCode: code,
        candidateProbabilities,
      },
      modelCallIds,
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    };
  }

  // Sort qualifying candidates: P(yes) desc, then original candidateIndex asc
  qualifying.sort((a, b) => b.prob - a.prob || a.candidateIndex - b.candidateIndex);

  // Ambiguity / cardinality tie handling
  if (qualifying.length > maxPages) {
    const k = maxPages;
    if (qualifying[k - 1].prob === qualifying[k].prob) {
      const tiedProb = qualifying[k].prob;
      return {
        outcome: 'abstained',
        status: 'abstained',
        pages: [],
        selectedProbability: qualifying[0].prob,
        vendorConfidence: null,
        probabilityBasis: 'noul_probability',
        candidateProbabilities,
        source: 'jev',
        abstentionCode: 'cardinality_limit_exceeded',
        abstentionReason: `cardinality_limit_exceeded: Ambiguity at cardinality limit (${maxPages}): multiple candidates share identical probability (${tiedProb.toFixed(3)}) at the selection boundary.`,
        derivation: {
          kind: 'systemone_judgment',
          primitive: 'noul',
          questionId: JEV_PAGE_QUESTION_ID,
          selectedProbability: qualifying[0].prob,
          vendorConfidence: null,
          probabilityBasis: 'noul_probability',
          abstentionCode: 'cardinality_limit_exceeded',
          candidateProbabilities,
        },
        modelCallIds,
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      };
    }
    qualifying = qualifying.slice(0, maxPages);
  }

  // Normalize page assignments (Shop All suppression, brand-page shortcut, species filter)
  const initialPages = qualifying.map(q => ({
    pageId: q.pageId,
    pageName: q.pageName,
    confidence: q.prob,
    isBrandShortcut: false,
  }));

  const normalizedPages = normalizePageAssignments(
    initialPages,
    pageIndex,
    resolvedBrand,
    productSpecies,
    maxPages,
    'multiple',
  );

  if (normalizedPages.length === 0) {
    return {
      outcome: 'abstained',
      status: 'abstained',
      pages: [],
      selectedProbability: qualifying[0]?.prob ?? null,
      vendorConfidence: null,
      probabilityBasis: 'noul_probability',
      candidateProbabilities,
      source: 'jev',
      abstentionCode: 'species_conflict',
      abstentionReason: 'Proposed category pages filtered out by deterministic rules (e.g. cross-species conflict).',
      derivation: {
        kind: 'systemone_judgment',
        primitive: 'noul',
        questionId: JEV_PAGE_QUESTION_ID,
        selectedProbability: qualifying[0]?.prob ?? null,
        vendorConfidence: null,
        probabilityBasis: 'noul_probability',
        abstentionCode: 'species_conflict',
        candidateProbabilities,
      },
      modelCallIds,
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    };
  }

  // Category correctness validation
  const correctnessResult = validateCategoryPageAssignment({
    member: {
      onboardingItemId: sku,
      frozenEvidenceHash: snapshot?.snapshotHash ?? '',
      frozenEvidence: {
        species: productSpecies,
        productType: productContext.productType,
        title: productContext.productName ?? null,
        description: productContext.productDescription ?? null,
        brand: resolvedBrand,
      },
      frozenProductTypeContext: productContext.productType,
    },
    candidate: {
      primaryPageId: normalizedPages[0].pageId,
      secondaryPageIds: normalizedPages.slice(1).map(p => p.pageId),
      primaryPageName: normalizedPages[0].pageName,
    },
    verifiedPageCatalog: verifiedRecords.map(r => ({
      id: r.pageId,
      name: r.pageName,
      parentId: r.parentPageId ?? null,
    })),
    activePageImportHash: snapshot?.snapshotHash ?? '',
  });

  if (correctnessResult.outcome === 'blocked' || !correctnessResult.valid) {
    return {
      outcome: 'abstained',
      status: 'abstained',
      pages: [],
      selectedProbability: qualifying[0]?.prob ?? null,
      vendorConfidence: null,
      probabilityBasis: 'noul_probability',
      candidateProbabilities,
      source: 'jev',
      abstentionCode: 'validation_blocked',
      abstentionReason: correctnessResult.reason ?? 'Category page validation failed.',
      derivation: {
        kind: 'systemone_judgment',
        primitive: 'noul',
        questionId: JEV_PAGE_QUESTION_ID,
        selectedProbability: qualifying[0]?.prob ?? null,
        vendorConfidence: null,
        probabilityBasis: 'noul_probability',
        abstentionCode: 'validation_blocked',
        candidateProbabilities,
      },
      modelCallIds,
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    };
  }

  const topProb = normalizedPages[0]?.confidence ?? qualifying[0].prob;

  return {
    outcome: 'predicted',
    status: 'succeeded',
    pages: normalizedPages.map(p => ({
      ...p,
      selectedProbability: p.confidence,
      vendorConfidence: null,
      probabilityBasis: p.isBrandShortcut ? 'brand_shortcut' : 'noul_probability',
    })),
    selectedProbability: topProb,
    vendorConfidence: null,
    probabilityBasis: 'noul_probability',
    candidateProbabilities,
    source: 'jev',
    modelCallIds,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
    derivation: {
      kind: 'systemone_judgment',
      primitive: 'noul',
      questionId: JEV_PAGE_QUESTION_ID,
      selectedProbability: topProb,
      vendorConfidence: null,
      probabilityBasis: 'noul_probability',
      candidateProbabilities,
    },
  };
}

/**
 * Build ClassificationProposal objects from a resolved PageDecisionResult.
 */
export function buildProposalsFromPageDecision(
  decision: PageDecisionResult,
  sku: string,
  runId: string,
  snapshotHash?: string | null,
): ClassificationProposal[] {
  if (decision.status === 'succeeded' && decision.pages.length > 0) {
    return decision.pages.map(p =>
      buildCategoryPageProposal({
        runId,
        sku,
        pageId: p.pageId,
        pageName: p.pageName,
        confidence: p.confidence,
        evidenceIds: decision.evidenceIds,
        supportingEvidenceIds: decision.supportingEvidenceIds.length > 0 ? decision.supportingEvidenceIds : undefined,
        contradictingEvidenceIds: decision.contradictingEvidenceIds.length > 0 ? decision.contradictingEvidenceIds : undefined,
        verifiedPageIdentity: true,
        isBulkAcceptable: false, // Jev proposals are strictly non-bulk-acceptable
        snapshotHash,
        modelCallIds: p.isBrandShortcut ? [] : decision.modelCallIds,
        derivation: p.isBrandShortcut ? { kind: 'deterministic_enrichment' } : decision.derivation,
      }),
    );
  }

  // Explicit reviewable abstention
  const abstentionProposal: ClassificationProposal = {
    id: randomUUID(),
    runId,
    productSku: sku,
    proposalType: 'reviewable_abstention',
    targetId: JEV_PAGE_QUESTION_ID,
    proposedValue: {
      reason: decision.abstentionReason ?? 'Category Page could not be resolved.',
      code: decision.abstentionCode ?? 'unresolved',
      targetId: JEV_PAGE_QUESTION_ID,
      selectedProbability: decision.selectedProbability ?? null,
      vendorConfidence: decision.vendorConfidence ?? null,
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

  return [abstentionProposal];
}
