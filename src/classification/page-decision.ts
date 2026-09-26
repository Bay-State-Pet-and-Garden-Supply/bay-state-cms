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
  recordTerminalPreflight,
} from '../db/repositories/classification-model-call-repo';
import type { ProductLineItemSnapshot } from './types';
import type { CohortPageMemberResult, CohortPageOption } from './cohort-page-proposal-engine';
import type { ExecutionTypeTitleAuthority } from './cohort-decision-authority';
import type { SystemOneQuestion } from '../shared/schemas/systemone';
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

      if (!isSystemOneModelMatch(request.model, result.returnedModel)) {
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

// ─── Cohort Page Coordination via TypeSafe Jev System One ─────────────────────

function abstainAllPages(
  products: ProductLineItemSnapshot[],
  reason: string,
): Map<string, CohortPageMemberResult> {
  return new Map(products.map(product => [product.sku, { status: 'abstained' as const, reason }]));
}

export interface CoordinateCohortPagesWithJevParams {
  groupId: string;
  products: ProductLineItemSnapshot[];
  pages: CohortPageOption[];
  selectionMode: 'single' | 'multiple';
  maxPages: number;
  modelPolicy?: ModelPolicyView | null;
  modelCall?: ModelCallContext | null;
  snapshot?: RuntimeClassificationSnapshot | null;
}

export interface CoordinateCohortPagesWithJevOptions {
  assertHeld?: () => void;
  afterCoordinatedCall?: () => void | Promise<void>;
  executionTypeContext?: ExecutionTypeTitleAuthority | null;
  allowSingleProduct?: boolean;
  protectedOperation?: ProtectedOperation;
}

export async function coordinateCohortPagesWithJev(
  params: CoordinateCohortPagesWithJevParams,
  opts?: CoordinateCohortPagesWithJevOptions,
): Promise<Map<string, CohortPageMemberResult>> {
  // 1. Guard against insufficient products (unless single-product is explicitly allowed)
  if (params.products.length < 2 && opts?.allowSingleProduct !== true) {
    return abstainAllPages(params.products, 'Cohort page coordination requires at least two products.');
  }

  if (params.pages.length === 0) {
    return abstainAllPages(params.products, 'No configured Category Pages are available.');
  }

  if (new Set(params.products.map(p => p.sku)).size !== params.products.length) {
    return abstainAllPages(params.products, 'Cohort input contains duplicate SKUs.');
  }

  // 2. Protected operation resolution and provenance assertion
  const operation = opts?.protectedOperation ?? 'cohort_page_assignment';
  if (params.modelCall && params.modelCall.operation !== operation) {
    throw new Error(
      `Cohort page coordination provenance mismatch: model-call context operation "${params.modelCall.operation}" ` +
        `differs from the effective protected operation "${operation}".`,
    );
  }

  // 3. Resolve Model Policy Route
  const rawPolicy = params.modelPolicy ?? (params.snapshot ? params.snapshot.modelPolicy : null);
  const effectivePolicy: ModelPolicyView | null =
    rawPolicy && typeof rawPolicy === 'object' && 'policyDigest' in rawPolicy && 'providerLocalities' in rawPolicy
      ? (rawPolicy as ModelPolicyView)
      : null;

  if (!effectivePolicy) {
    opts?.assertHeld?.();
    return abstainAllPages(params.products, 'No category_page_assignment LLM is configured.');
  }

  let route: ReturnType<typeof resolveModelRoute> | null = null;
  let conn: any = null;

  try {
    assertModelPolicyIntact(effectivePolicy);
    route = resolveModelRoute(effectivePolicy, operation, {
      getCredential: (p: string) => resolveCredential(p),
      defaultBaseUrls: {
        typesafe: 'https://api.typesafe.ai/v1',
      },
    });
    const aiConfig = getFullAiRoutingConfig();
    conn =
      aiConfig.connections[route.provider] ||
      Object.values(aiConfig.connections).find(
        (c) => c.id === route!.provider || (route!.provider === 'typesafe' && (c.id === 'typesafe-jev' || c.transport === 'systemone')),
      );
  } catch (err: any) {
    if (err instanceof HeartbeatLostError) throw err;
    if (err instanceof ModelPolicyDeniedError) {
      opts?.assertHeld?.();
      recordTerminalPreflight(
        params.modelCall,
        effectivePolicy.policyDigest,
        MODEL_CALL_STATUS.policyDenied,
        `Model policy denied cohort page assignment (${err.message}).`,
      );
      return abstainAllPages(params.products, 'Cohort page LLM policy denied.');
    }
    throw err;
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

  try {
    assertConnectionEnabledForDispatch(jevConn as any, route.model || TYPESAFE_EVALUATED_MODEL);
  } catch (err: any) {
    opts?.assertHeld?.();
    recordTerminalPreflight(
      params.modelCall,
      effectivePolicy.policyDigest,
      MODEL_CALL_STATUS.unavailable,
      `Connection disabled or invalid for dispatch: ${err.message}`,
    );
    return abstainAllPages(params.products, `TypeSafe connection not available: ${err.message}`);
  }

  opts?.assertHeld?.();

  // Audit context plan verification if snapshot supplied
  if (params.snapshot) {
    assertModelPlanCompatible(params.snapshot, operation, {
      runId: params.modelCall?.runId ?? '',
      snapshotHash: params.snapshot.snapshotHash,
      stage: 'category_page_proposals',
      operation,
      attempt: params.modelCall?.attempt ?? 1,
      promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS[operation],
      ruleVersion: RULE_VERSIONS[operation],
    });
  }

  // 4. Candidate verification and candidate-limit check
  const candidates: PageCandidateItem[] = params.pages.map(p => ({
    pageId: p.id,
    pageName: p.name,
    parentId: null,
    parentName: p.parentName,
    path: p.parentName ? `${p.parentName} > ${p.name}` : p.name,
  }));
  const pageIndex = new Map(params.pages.map(p => [p.name, { id: p.id, name: p.name }]));

  if (params.selectionMode === 'single' && candidates.length > MAX_ORDINARY_PAGE_CANDIDATES) {
    return abstainAllPages(
      params.products,
      `candidate_limit_exceeded: Candidate Category Pages (${candidates.length}) exceed maximum Choice capacity of ${MAX_ORDINARY_PAGE_CANDIDATES}. First-N clipping is forbidden.`,
    );
  }

  // 5. Construct Bounded State
  const execContext = opts?.executionTypeContext;
  const typeLabel = execContext?.label ?? execContext?.id ?? null;
  const typeDesc = typeLabel ? `"${typeLabel}"` : 'product';

  const memberStates = params.products.map(p => ({
    sku: p.sku,
    name: p.name.slice(0, 500),
    webTitle: (p.webTitle ?? '').slice(0, 500) || null,
    brand: (p.brand ?? '').slice(0, 200) || null,
    description: (p.description ?? '').slice(0, 1000) || null,
    species: [...(p.species ?? [])].sort(),
    flavor: p.flavor ?? null,
    lifeStage: p.lifeStage ?? null,
    productForm: p.productForm ?? null,
    healthConcern: [...(p.healthConcern ?? [])].sort(),
  }));

  const baseState: Record<string, unknown> = {
    groupId: params.groupId,
    productTypeContext: {
      id: execContext?.id ?? null,
      label: execContext?.label ?? null,
      confidence: execContext?.confidence ?? null,
      outcome: execContext?.outcome ?? null,
    },
    members: memberStates,
  };

  const stateStr = JSON.stringify(baseState);
  if (Buffer.byteLength(stateStr, 'utf-8') > SYSTEMONE_MAX_STATE_BYTES) {
    baseState.members = memberStates.map(m => ({
      ...m,
      description: m.description ? m.description.slice(0, 300) : null,
    }));
  }

  // 6. Build Question Plans
  type QuestionPlanEntry =
    | {
        kind: 'choice';
        sku: string;
        product: ProductLineItemSnapshot;
        questionId: string;
        questionPlan: PageChoiceQuestionPlan;
        payload: SystemOneQuestion;
      }
    | {
        kind: 'noul';
        sku: string;
        product: ProductLineItemSnapshot;
        questionId: string;
        candidate: PageCandidateItem;
        candidateIndex: number;
        payload: SystemOneQuestion;
      };

  const allQuestions: QuestionPlanEntry[] = [];

  if (params.selectionMode === 'single') {
    for (const product of params.products) {
      const sanitizedSku = product.sku.replace(/[^A-Za-z0-9_.-]/g, '_');
      const questionId = `page_choice_${sanitizedSku}`;
      const questionPlan = buildPageChoiceQuestion(candidates, typeLabel);
      const instructions =
        `For product variant SKU "${product.sku}" (${product.name}), select the single most specific and appropriate store category page for this ${typeDesc} from the eligible catalog choices based strictly on this SKU's own evidence. ` +
        `Every product variant must be judged independently from its own evidence; do not copy, union, or rely on other products in the cohort. ` +
        `If none of the specific options apply to SKU "${product.sku}", select "${NO_MATCH_CHOICE_KEY}". ` +
        `If the evidence for SKU "${product.sku}" does not provide enough information to determine the page with confidence, select "${INSUFFICIENT_EVIDENCE_CHOICE_KEY}".`;

      allQuestions.push({
        kind: 'choice',
        sku: product.sku,
        product,
        questionId,
        questionPlan,
        payload: {
          type: 'choice',
          instructions,
          criteria: questionPlan.criteria,
        },
      });
    }
  } else {
    // Multiple mode
    const eligibleCandidates = candidates.filter(c => !c.pageName.toLowerCase().startsWith('brand -'));
    for (const product of params.products) {
      const sanitizedSku = product.sku.replace(/[^A-Za-z0-9_.-]/g, '_');
      for (let idx = 0; idx < eligibleCandidates.length; idx++) {
        const cand = eligibleCandidates[idx];
        const sanitizedPageId = cand.pageId.replace(/[^A-Za-z0-9_.-]/g, '_');
        const questionId = `page_noul_${sanitizedSku}_${sanitizedPageId}`;
        const instructions =
          `Does the store category page "${cand.pageName}" (Path: "${cand.path}") apply to product variant SKU "${product.sku}" (${product.name})? ` +
          `Evaluate SKU "${product.sku}" strictly from its own product evidence; do not rely on or copy assignments from sibling products in the cohort.`;
        const criteria = {
          true: `The product SKU "${product.sku}" belongs in the category page "${cand.pageName}" based strictly on its own evidence.`,
          false: `The product SKU "${product.sku}" does NOT belong in the category page "${cand.pageName}".`,
        };

        allQuestions.push({
          kind: 'noul',
          sku: product.sku,
          product,
          questionId,
          candidate: cand,
          candidateIndex: idx,
          payload: {
            type: 'noul',
            instructions,
            criteria,
          },
        });
      }
    }
  }

  // 7. Request Partitioning (Batches <= 32 questions)
  const questionBatches: QuestionPlanEntry[][] = [];
  for (let i = 0; i < allQuestions.length; i += SYSTEMONE_MAX_QUESTIONS) {
    questionBatches.push(allQuestions.slice(i, i + SYSTEMONE_MAX_QUESTIONS));
  }

  const allAnswers: Record<string, any> = {};
  const modelCallIds: string[] = [];

  for (const batch of questionBatches) {
    opts?.assertHeld?.();
    const questionsRecord: Record<string, any> = {};
    for (const q of batch) {
      questionsRecord[q.questionId] = q.payload;
    }

    const request = {
      model: route.model || TYPESAFE_EVALUATED_MODEL,
      state: baseState,
      questions: questionsRecord,
    };

    const promptHash = hashCanonicalJson(request);
    const callId = params.modelCall?.runId
      ? insertModelCallStart({
          runId: params.modelCall.runId,
          stageName: 'category_page_proposals',
          operation,
          attempt: params.modelCall.attempt ?? 1,
          provider: route.provider,
          model: route.model,
          requestedModel: route.model,
          locality: route.locality,
          snapshotHash: params.snapshot?.snapshotHash ?? (params.modelCall.snapshotHash ?? ''),
          modelPolicyDigest: effectivePolicy.policyDigest,
          promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS[operation],
          ruleVersion: RULE_VERSIONS[operation],
          systemPromptHash: promptHash,
          userPromptHash: promptHash,
        })
      : null;
    if (callId) {
      modelCallIds.push(callId);
    }

    const startedAt = Date.now();
    let dispatchRes: any;

    try {
      opts?.assertHeld?.();
      dispatchRes = await dispatchSystemOne(jevConn as any, request);
      opts?.assertHeld?.();

      if (!isSystemOneModelMatch(request.model, dispatchRes.returnedModel)) {
        throw new Error(
          `Model mismatch: requested model "${request.model}", but provider returned "${dispatchRes.returnedModel}". Pinned model substitution is forbidden.`,
        );
      }

      const durationMs = Date.now() - startedAt;
      if (callId) {
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
      }

      for (const q of batch) {
        const ans = dispatchRes.answers[q.questionId];
        if (!ans || ans.type !== q.payload.type) {
          throw new Error(`Expected ${q.payload.type} answer for question "${q.questionId}", got "${ans?.type ?? 'missing'}".`);
        }
        allAnswers[q.questionId] = ans;
      }
    } catch (err: any) {
      if (err instanceof HeartbeatLostError) throw err;
      opts?.assertHeld?.();
      const latencyMs = Date.now() - startedAt;
      if (callId) {
        completeModelCall(callId, {
          status: MODEL_CALL_STATUS.failed,
          endedAt: now(),
          costBasis: COST_BASIS.unknown,
          errorMessage: err instanceof Error ? err.message : String(err),
          durationMs: latencyMs,
        });
      }

      // Two-level atomicity: model or response dispatch failure marks the model call failed
      // and abstains the affected cohort chunk. Other chunks may succeed.
      return abstainAllPages(params.products, `TypeSafe Jev dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Crash seam: fires after the coordinated call resolves, before returning to caller
  await opts?.afterCoordinatedCall?.();

  // 8. Member Judgment Evaluation (Singleton Choice/Noul semantics per member)
  const resultMap = new Map<string, CohortPageMemberResult>();

  if (params.selectionMode === 'single') {
    for (const q of allQuestions as Extract<QuestionPlanEntry, { kind: 'choice' }>[]) {
      const product = q.product;
      const ans = allAnswers[q.questionId];
      if (!ans || ans.type !== 'choice') {
        resultMap.set(product.sku, { status: 'abstained', reason: `Missing answer for question ${q.questionId}` });
        continue;
      }

      const chosenKey = ans.choice;
      const selectedProbability = ans.probabilities[chosenKey] ?? 0;

      if (chosenKey === NO_MATCH_CHOICE_KEY) {
        resultMap.set(product.sku, {
          status: 'abstained',
          reason: 'no_match: No matching Category Page in the catalog applies to this product.',
        });
        continue;
      }

      if (chosenKey === INSUFFICIENT_EVIDENCE_CHOICE_KEY) {
        resultMap.set(product.sku, {
          status: 'abstained',
          reason: 'insufficient_evidence: Product evidence is insufficient to determine the correct Category Page.',
        });
        continue;
      }

      const pageId = q.questionPlan.keyToIdMap.get(chosenKey);
      const candidate = candidates.find(c => c.pageId === pageId);
      if (!pageId || !candidate) {
        resultMap.set(product.sku, {
          status: 'abstained',
          reason: `Selected choice key "${chosenKey}" could not be mapped to a known candidate page.`,
        });
        continue;
      }

      if (selectedProbability < JEV_PAGE_SINGLE_THRESHOLD) {
        resultMap.set(product.sku, {
          status: 'abstained',
          reason: `insufficient_evidence: Selected category page probability ${selectedProbability.toFixed(3)} is below required threshold ${JEV_PAGE_SINGLE_THRESHOLD.toFixed(2)}.`,
        });
        continue;
      }

      // Apply deterministic normalization
      const initialPages = [{
        pageId: candidate.pageId,
        pageName: candidate.pageName,
        confidence: selectedProbability,
        isBrandShortcut: false,
      }];

      const normalizedPages = normalizePageAssignments(
        initialPages,
        pageIndex,
        product.brand ?? null,
        product.species ?? [],
        1,
        'single',
      );

      if (normalizedPages.length === 0) {
        resultMap.set(product.sku, {
          status: 'abstained',
          reason: 'Proposed category page filtered out by deterministic rules (e.g. cross-species conflict).',
        });
        continue;
      }

      // Category correctness validation
      const correctness = validateCategoryPageAssignment({
        member: {
          onboardingItemId: product.sku,
          frozenEvidenceHash: params.snapshot?.snapshotHash ?? '',
          frozenEvidence: {
            species: product.species ?? [],
            productType: typeLabel,
            title: product.name,
            description: product.description,
            brand: product.brand,
          },
          frozenProductTypeContext: typeLabel,
        },
        candidate: {
          primaryPageId: normalizedPages[0].pageId,
          secondaryPageIds: [],
          primaryPageName: normalizedPages[0].pageName,
        },
        verifiedPageCatalog: candidates.map(c => ({
          id: c.pageId,
          name: c.pageName,
          parentId: c.parentId,
        })),
        activePageImportHash: params.snapshot?.snapshotHash ?? '',
      });

      if (!correctness.valid || correctness.outcome === 'blocked') {
        resultMap.set(product.sku, {
          status: 'abstained',
          reason: correctness.reason ?? 'Category page validation failed.',
        });
        continue;
      }

      resultMap.set(product.sku, {
        status: 'assigned',
        pages: normalizedPages.map(p => ({
          pageId: p.pageId,
          pageName: p.pageName,
          confidence: p.confidence,
          isBrandShortcut: p.isBrandShortcut,
        })),
        modelCallIds,
        source: 'typesafe',
      });
    }
  } else {
    // Multiple mode
    const noulEntries = allQuestions as Extract<QuestionPlanEntry, { kind: 'noul' }>[];
    const noulBySku = new Map<string, typeof noulEntries>();
    for (const entry of noulEntries) {
      const list = noulBySku.get(entry.sku) ?? [];
      list.push(entry);
      noulBySku.set(entry.sku, list);
    }

    for (const product of params.products) {
      const entries = noulBySku.get(product.sku) ?? [];
      const evaluations: Array<{ pageId: string; pageName: string; prob: number; candidateIndex: number }> = [];

      for (const entry of entries) {
        const ans = allAnswers[entry.questionId];
        const prob = ans?.noul ?? 0;
        evaluations.push({
          pageId: entry.candidate.pageId,
          pageName: entry.candidate.pageName,
          prob,
          candidateIndex: entry.candidateIndex,
        });
      }

      const qualifying = evaluations.filter(e => e.prob >= JEV_PAGE_MULTI_THRESHOLD);

      if (qualifying.length === 0) {
        const maxP = Math.max(...evaluations.map(e => e.prob), 0);
        const reason = maxP < JEV_PAGE_MULTI_UNCERTAIN_FLOOR
          ? 'no_match: No Category Page in the catalog applies to this product with sufficient confidence.'
          : `insufficient_evidence: Product evidence is insufficient to assign Category Pages with confidence (highest probability ${maxP.toFixed(3)} is below threshold ${JEV_PAGE_MULTI_THRESHOLD.toFixed(2)}).`;

        resultMap.set(product.sku, { status: 'abstained', reason });
        continue;
      }

      qualifying.sort((a, b) => b.prob - a.prob || a.candidateIndex - b.candidateIndex);

      if (qualifying.length > params.maxPages) {
        const k = params.maxPages;
        if (qualifying[k - 1].prob === qualifying[k].prob) {
          const tiedProb = qualifying[k].prob;
          resultMap.set(product.sku, {
            status: 'abstained',
            reason: `cardinality_limit_exceeded: Ambiguity at cardinality limit (${params.maxPages}): multiple candidates share identical probability (${tiedProb.toFixed(3)}) at the selection boundary.`,
          });
          continue;
        }
      }

      const selected = qualifying.slice(0, params.maxPages);
      const initialPages = selected.map(s => ({
        pageId: s.pageId,
        pageName: s.pageName,
        confidence: s.prob,
        isBrandShortcut: false,
      }));

      // Check brand landing page shortcut rule
      if (product.brand) {
        const brandPageName = `Brand - ${product.brand}`;
        const exactBrandPage = pageIndex.get(brandPageName);
        if (exactBrandPage && !initialPages.some(p => p.pageId === exactBrandPage.id)) {
          initialPages.push({
            pageId: exactBrandPage.id,
            pageName: exactBrandPage.name,
            confidence: 0.99,
            isBrandShortcut: true,
          });
        }
      }

      const normalized = normalizePageAssignments(
        initialPages,
        pageIndex,
        product.brand ?? null,
        product.species ?? [],
        params.maxPages,
        'multiple',
      );

      if (normalized.length === 0) {
        resultMap.set(product.sku, {
          status: 'abstained',
          reason: 'Proposed category pages filtered out by deterministic rules.',
        });
        continue;
      }

      const correctness = validateCategoryPageAssignment({
        member: {
          onboardingItemId: product.sku,
          frozenEvidenceHash: params.snapshot?.snapshotHash ?? '',
          frozenEvidence: {
            species: product.species ?? [],
            productType: typeLabel,
            title: product.name,
            description: product.description,
            brand: product.brand,
          },
          frozenProductTypeContext: typeLabel,
        },
        candidate: {
          primaryPageId: normalized[0].pageId,
          secondaryPageIds: normalized.slice(1).map(p => p.pageId),
          primaryPageName: normalized[0].pageName,
        },
        verifiedPageCatalog: candidates.map(c => ({
          id: c.pageId,
          name: c.pageName,
          parentId: c.parentId,
        })),
        activePageImportHash: params.snapshot?.snapshotHash ?? '',
      });

      if (!correctness.valid || correctness.outcome === 'blocked') {
        resultMap.set(product.sku, {
          status: 'abstained',
          reason: correctness.reason ?? 'Category page validation failed.',
        });
        continue;
      }

      resultMap.set(product.sku, {
        status: 'assigned',
        pages: normalized.map(p => ({
          pageId: p.pageId,
          pageName: p.pageName,
          confidence: p.confidence,
          isBrandShortcut: p.isBrandShortcut,
        })),
        modelCallIds,
        source: 'typesafe',
      });
    }
  }

  return resultMap;
}
