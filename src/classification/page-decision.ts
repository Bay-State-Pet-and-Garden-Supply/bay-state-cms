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
  SYSTEMONE_MAX_QUESTIONS,
  TYPESAFE_EVALUATED_MODEL,
} from '../ai/systemone-transport';
import {
  assertConnectionEnabledForDispatch,
} from '../ai/provider-connections';
import { getFullAiRoutingConfig } from '../db/repositories/provider-connection-repo';
import {
  insertModelCallStart,
  completeModelCall,
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
  type PageSnapshotRecord,
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
import {
  MAX_ORDINARY_CHOICE_CANDIDATES,
  SYSTEMONE_MULTI_MIN_PROBABILITY,
  SYSTEMONE_MULTI_UNCERTAIN_FLOOR,
  SYSTEMONE_SINGLE_CHOICE_MIN_PROBABILITY,
  applyCardinalityLimit,
  assertSystemOneModelMatch,
  buildChoiceJudgmentDerivation,
  buildNoulJudgmentDerivation,
  buildPageChoiceKeyMaps,
  findSystemOneConnection,
  fitStateToBudget,
  maxCandidateProbability,
  requireChoiceAnswer,
  requireNoulAnswer,
  resolveDecisionRouteForOperation,
  resolveSystemOneCredential,
  asEffectivePolicyView,
  insertPolicyDeniedTerminalCall,
  openDecisionModelCall,
  openSingleChoiceRequest,
  sanitizeQuestionIdSegment,
  sortCandidatesByProbability,
} from './systemone-decision-core';
import type { ProtectedOperation } from './model-operation-registry';

// ─── Versioned Constants ──────────────────────────────────────────────────────

export const PAGE_JUDGMENT_VERSION = 'jev-page-v1';
export const PAGE_QUESTION_VERSION = 'page-question-v1';

export const JEV_PAGE_QUESTION_ID = 'category_page_assignment';
const MAX_ORDINARY_PAGE_CANDIDATES = MAX_ORDINARY_CHOICE_CANDIDATES; // 253

export const JEV_PAGE_SINGLE_THRESHOLD = SYSTEMONE_SINGLE_CHOICE_MIN_PROBABILITY; // 0.50
const JEV_PAGE_MULTI_THRESHOLD = SYSTEMONE_MULTI_MIN_PROBABILITY; // 0.70
const JEV_PAGE_MULTI_UNCERTAIN_FLOOR = SYSTEMONE_MULTI_UNCERTAIN_FLOOR; // 0.40

export const NO_MATCH_CHOICE_KEY = 'abstain_no_match';
export const INSUFFICIENT_EVIDENCE_CHOICE_KEY = 'abstain_insufficient_evidence';

const PAGE_CONTEXT_SOURCE_FIELDS = [
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
const PAGE_CONTEXT_ATTRIBUTE_IDS = ['species', 'brand'];

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
/**
 * Map restricted packet evidence to bounded state records (id-ordered).
 */
function buildPageEvidenceRecords(evidence: ClassificationEvidence[]): Array<{
  source: string;
  sourceField: string | null;
  value: unknown;
  snippet: string | null;
  reliability: string;
}> {
  return evidence
    .slice()
    .sort((a, b) => (a.id ?? '').localeCompare(b.id ?? ''))
    .map(e => ({
      source: e.source,
      sourceField: e.sourceField ?? null,
      value: typeof e.value === 'string' ? e.value.slice(0, 500) : e.value,
      snippet: typeof e.snippet === 'string' ? e.snippet.slice(0, 500) : null,
      reliability: e.reliability,
    }));
}

/**
 * Describe the page decision's product context for bounded state (all
 * optional fields defaulted, description truncated).
 */
function describePageProductContext(productContext?: PageDecisionProductContext): {
  productName: string | null;
  productDescription: string | null;
  productType: string | null;
  species: string[] | null;
  brand: string | null;
} {
  return {
    productName: productContext?.productName ?? null,
    productDescription: truncatePageProductDescription(productContext),
    productType: productContext?.productType ?? null,
    ...describePageProductTaxonomy(productContext),
  };
}

/**
 * Truncated product description for bounded page state (null when absent).
 */
function truncatePageProductDescription(productContext?: PageDecisionProductContext): string | null {
  const description = productContext?.productDescription;
  return description ? description.slice(0, 1000) : null;
}

/**
 * Taxonomy context for bounded page state (species/brand defaulted null).
 */
function describePageProductTaxonomy(productContext?: PageDecisionProductContext): {
  species: string[] | null;
  brand: string | null;
} {
  return {
    species: productContext?.ocrSummary?.species ?? null,
    brand: productContext?.ocrSummary?.brand ?? null,
  };
}

function buildPageState(
  evidence: ClassificationEvidence[],
  sku: string,
  productContext?: PageDecisionProductContext,
): Record<string, unknown> {
  const evidenceRecords = buildPageEvidenceRecords(evidence);

  const baseState: Record<string, unknown> = {
    sku,
    ...describePageProductContext(productContext),
    evidenceCount: evidenceRecords.length,
    evidenceRecords,
  };

  fitStateToBudget(baseState, s => {
    s.evidenceRecords = evidenceRecords.slice(0, 5);
  });

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
  const criteria: Record<string, string> = {};
  const { keyToIdMap, idToKeyMap } = buildPageChoiceKeyMaps(criteria, candidates);

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

interface PageNoulQuestionPlan {
  questionId: string;
  pageId: string;
  pageName: string;
  candidateIndex: number;
  instructions: string;
  criteria: { true: string; false: string };
}

function buildPageNoulQuestions(
  candidates: PageCandidateItem[],
  sku: string,
  productContext?: PageDecisionProductContext,
): PageNoulQuestionPlan[] {
  const name = productContext?.productName || sku;

  return candidates.map((cand, i) => {
    const cleanId = sanitizeQuestionIdSegment(cand.pageId);
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

type PageSingleDispatchOutcome =
  | { outcome: 'abstained' | 'failed'; result: PageDecisionResult }
  | { outcome: 'dispatched'; dispatchResult: any; callId: string; questionPlan: PageChoiceQuestionPlan };

/**
 * Dispatch one single-mode Choice question with audit rows. Semantic
 * abstentions and dispatch failures return terminal results; otherwise the
 * raw dispatch payload comes back for mapping and post-checks.
 */
type PageSingleCallPreparation = {
  questionPlan: PageChoiceQuestionPlan;
  request: { model: string; state: Record<string, unknown>; questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }> };
  callId: string;
  startedAt: number;
};

/**
 * Open one single-mode Choice call: question, bounded request, hashing, and
 * the durable audit start row.
 */
function openPageSingleChoiceCall(input: {
  candidates: PageCandidateItem[];
  productType: string | null | undefined;
  route: ReturnType<typeof resolveModelRoute>;
  state: Record<string, unknown>;
  runId: string;
  ctx: ModelCallContext;
  effectivePolicy: ModelPolicyView;
}): PageSingleCallPreparation {
  const { candidates, productType, route, state, runId, ctx, effectivePolicy } = input;
  const questionPlan = buildPageChoiceQuestion(candidates, productType);

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
 * Record one failed single-mode Choice dispatch (no post-loss writes).
 */
function failPageSingleChoiceDispatch(input: {
  err: unknown;
  callId: string;
  startedAt: number;
  assertHeld?: () => void;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): PageSingleDispatchOutcome {
  const { err, callId, startedAt, assertHeld, evidenceIds, supportingEvidenceIds, contradictingEvidenceIds } = input;
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

  return { outcome: 'failed', result: {
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
    } };
}

async function dispatchPageSingleChoiceQuestion(input: {
  candidates: PageCandidateItem[];
  productType: string | null | undefined;
  route: ReturnType<typeof resolveModelRoute>;
  jevConn: any;
  state: Record<string, unknown>;
  runId: string;
  ctx: ModelCallContext;
  effectivePolicy: ModelPolicyView;
  assertHeld?: () => void;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): Promise<PageSingleDispatchOutcome> {
  const {
    candidates,
    productType,
    route,
    jevConn,
    state,
    runId,
    ctx,
    effectivePolicy,
    assertHeld,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  } = input;
    const prepared = openPageSingleChoiceCall({
      candidates,
      productType,
      route,
      state,
      runId,
      ctx,
      effectivePolicy,
    });
    const { questionPlan, request, callId, startedAt } = prepared;
    let result: any;

    try {
      assertHeld?.();
      result = await dispatchSystemOne(jevConn as any, request);
      assertHeld?.();

      assertSystemOneModelMatch(request.model, result.returnedModel);

      const durationMs = Date.now() - startedAt;
      const answer = requireChoiceAnswer(result.answers, questionPlan.questionId);

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
        return { outcome: 'abstained', result: {
          outcome: 'abstained',
          status: 'abstained',
          pages: [],
          selectedProbability,
          vendorConfidence,
          probabilityBasis: 'choice_probability',
          source: 'jev',
          abstentionCode: 'no_match',
          abstentionReason: 'no_match: No matching Category Page in the catalog applies to this product.',
          derivation: buildChoiceJudgmentDerivation(JEV_PAGE_QUESTION_ID, selectedProbability, vendorConfidence, 'no_match'),
          modelCallIds: [callId],
          evidenceIds,
          supportingEvidenceIds,
          contradictingEvidenceIds,
        } };
      }

      if (chosenKey === INSUFFICIENT_EVIDENCE_CHOICE_KEY) {
        return { outcome: 'abstained', result: {
          outcome: 'abstained',
          status: 'abstained',
          pages: [],
          selectedProbability,
          vendorConfidence,
          probabilityBasis: 'choice_probability',
          source: 'jev',
          abstentionCode: 'insufficient_evidence',
          abstentionReason: 'insufficient_evidence: Product evidence is insufficient to determine the correct Category Page.',
          derivation: buildChoiceJudgmentDerivation(JEV_PAGE_QUESTION_ID, selectedProbability, vendorConfidence, 'insufficient_evidence'),
          modelCallIds: [callId],
          evidenceIds,
          supportingEvidenceIds,
          contradictingEvidenceIds,
        } };
      }
    } catch (err: any) {
      return failPageSingleChoiceDispatch({
        err,
        callId,
        startedAt,
        assertHeld,
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      });
    }
    return { outcome: 'dispatched', dispatchResult: result, callId, questionPlan };

}

/**
 * Map one answered single-mode Choice to its final prediction: key mapping,
 * the 0.50 floor, deterministic normalization, species filtering, category
 * correctness, then resolution.
 */
/**
 * Run category correctness validation for one single-mode page candidate.
 */
function validatePageSingleCorrectness(input: {
  sku: string;
  snapshot: RuntimeClassificationSnapshot | null | undefined;
  productSpecies: string[];
  productContext: PageDecisionProductContext;
  resolvedBrand: string | null;
  normalizedPages: Array<{ pageId: string; pageName: string }>;
  verifiedRecords: PageSnapshotRecord[];
}): ReturnType<typeof validateCategoryPageAssignment> {
  const { sku, snapshot, productSpecies, productContext, resolvedBrand, normalizedPages, verifiedRecords } = input;
  return validateCategoryPageAssignment({
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
}

/**
 * Map one answered single-mode choice key to its candidate page, failing
 * closed on unknown keys.
 */
function mapPageSingleChoiceKey(input: {
  questionPlan: PageChoiceQuestionPlan;
  candidates: PageCandidateItem[];
  chosenKey: string;
  selectedProbability: number;
  vendorConfidence: number;
  callId: string;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): { failed: PageDecisionResult } | { pageId: string; candidate: PageCandidateItem } {
  const { questionPlan, candidates, chosenKey, selectedProbability, vendorConfidence, callId, evidenceIds, supportingEvidenceIds, contradictingEvidenceIds } = input;
  const pageId = questionPlan.keyToIdMap.get(chosenKey);
  const candidate = candidates.find(c => c.pageId === pageId);

  if (!pageId || !candidate) {
    return { failed: {
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
    } };
  }
  return { pageId, candidate };
}

function finalizePageSinglePrediction(input: {
  dispatchResult: any;
  questionPlan: PageChoiceQuestionPlan;
  candidates: PageCandidateItem[];
  callId: string;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  pageIndex: Map<string, { id: string; name: string }>;
  resolvedBrand: string | null;
  productSpecies: string[];
  sku: string;
  snapshot: RuntimeClassificationSnapshot | null | undefined;
  productContext: PageDecisionProductContext;
  verifiedRecords: PageSnapshotRecord[];
}): PageDecisionResult {
  const {
    dispatchResult: result,
    questionPlan,
    candidates,
    callId,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
    pageIndex,
    resolvedBrand,
    productSpecies,
    sku,
    snapshot,
    productContext,
    verifiedRecords,
  } = input;
    const answer = result.answers[questionPlan.questionId];
    const chosenKey = answer.choice;
    const selectedProbability = answer.probabilities[chosenKey] ?? 0;
    const vendorConfidence = answer.confidence;

    const mapped = mapPageSingleChoiceKey({
      questionPlan,
      candidates,
      chosenKey,
      selectedProbability,
      vendorConfidence,
      callId,
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    });
    if ('failed' in mapped) return mapped.failed;
    const { candidate } = mapped;

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
        derivation: buildChoiceJudgmentDerivation(JEV_PAGE_QUESTION_ID, selectedProbability, vendorConfidence, 'insufficient_evidence'),
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
        derivation: buildChoiceJudgmentDerivation(JEV_PAGE_QUESTION_ID, selectedProbability, vendorConfidence, 'species_conflict'),
        modelCallIds: [callId],
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      };
    }

    // Category correctness validation
    const correctnessResult = validatePageSingleCorrectness({
      sku,
      snapshot,
      productSpecies,
      productContext,
      resolvedBrand,
      normalizedPages,
      verifiedRecords,
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
        derivation: buildChoiceJudgmentDerivation(JEV_PAGE_QUESTION_ID, selectedProbability, vendorConfidence, 'validation_blocked'),
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
      derivation: buildChoiceJudgmentDerivation(JEV_PAGE_QUESTION_ID, selectedProbability, vendorConfidence),
    };
}

/**
 * Execute single-mode Choice: candidate-limit guard, protected dispatch,
 * then mapping and post-check finalization.
 */
async function executePageSingleChoice(input: {
  candidates: PageCandidateItem[];
  productContext: PageDecisionProductContext;
  state: Record<string, unknown>;
  route: ReturnType<typeof resolveModelRoute>;
  jevConn: any;
  ctx: ModelCallContext;
  effectivePolicy: ModelPolicyView;
  runId: string;
  assertHeld?: () => void;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  pageIndex: Map<string, { id: string; name: string }>;
  resolvedBrand: string | null;
  productSpecies: string[];
  sku: string;
  snapshot: RuntimeClassificationSnapshot | null | undefined;
  verifiedRecords: PageSnapshotRecord[];
}): Promise<PageDecisionResult> {
  const {
    candidates,
    productContext,
    state,
    route,
    jevConn,
    ctx,
    effectivePolicy,
    runId,
    assertHeld,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
    pageIndex,
    resolvedBrand,
    productSpecies,
    sku,
    snapshot,
    verifiedRecords,
  } = input;
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
        derivation: buildChoiceJudgmentDerivation(JEV_PAGE_QUESTION_ID, null, null, 'candidate_limit_exceeded'),
        modelCallIds: [],
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      };
    }

    const singleDispatch = await dispatchPageSingleChoiceQuestion({
      candidates,
      productType: productContext.productType,
      route,
      jevConn,
      state,
      runId,
      ctx,
      effectivePolicy,
      assertHeld,
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    });
    if (singleDispatch.outcome !== 'dispatched') return singleDispatch.result;
    const result = singleDispatch.dispatchResult;
    const callId = singleDispatch.callId;
    const singleQuestionPlan = singleDispatch.questionPlan;

    const singleResult = finalizePageSinglePrediction({
      dispatchResult: result,
      questionPlan: singleQuestionPlan,
      candidates,
      callId,
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
      pageIndex,
      resolvedBrand,
      productSpecies,
      sku,
      snapshot,
    productContext,
    verifiedRecords,
  });
    return singleResult;
}

/**
 * Legacy chat-LLM page assigner fallback (non-SystemOne routes).
 */
/**
 * Assemble the legacy LLM assigner's OCR summary from the page decision's
 * product context (all optional fields defaulted).
 */
function buildPageLegacyOcrSummary(productContext: PageDecisionProductContext): {
  species: string[];
  flavor: string | null;
  lifeStage: string | null;
  productForm: string | null;
  healthConcern: string[];
  productName: string | null;
  brand: string | null;
} {
  const ocrSummary = productContext.ocrSummary;
  return {
    ...summarizePageOcrArrays(ocrSummary),
    ...summarizePageOcrScalars(ocrSummary),
  };
}

/**
 * Array-valued OCR summary fields (defaulted empty).
 */
function summarizePageOcrArrays(ocrSummary: PageDecisionProductContext['ocrSummary']): {
  species: string[];
  healthConcern: string[];
} {
  return {
    species: ocrSummary?.species ?? [],
    healthConcern: ocrSummary?.healthConcern ?? [],
  };
}

/**
 * Scalar OCR summary fields (defaulted null).
 */
function summarizePageOcrScalars(ocrSummary: PageDecisionProductContext['ocrSummary']): {
  flavor: string | null;
  lifeStage: string | null;
  productForm: string | null;
  productName: string | null;
  brand: string | null;
} {
  return {
    ...summarizePageOcrIdentity(ocrSummary),
    productForm: ocrSummary?.productForm ?? null,
    productName: ocrSummary?.productName ?? null,
    brand: ocrSummary?.brand ?? null,
  };
}

/**
 * Identity-related scalar OCR fields (defaulted null).
 */
function summarizePageOcrIdentity(ocrSummary: PageDecisionProductContext['ocrSummary']): {
  flavor: string | null;
  lifeStage: string | null;
} {
  return {
    flavor: ocrSummary?.flavor ?? null,
    lifeStage: ocrSummary?.lifeStage ?? null,
  };
}

/**
 * Map one legacy LLM assignment result to a terminal page decision.
 */
function mapPageLegacyResult(input: {
  llmResult: Awaited<ReturnType<typeof llmAssignCategoryPages>> | null;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): PageDecisionResult {
  const { llmResult, evidenceIds, supportingEvidenceIds, contradictingEvidenceIds } = input;
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

async function executePageLegacyFallback(input: {
  productContext: PageDecisionProductContext;
  rawHierarchy: ReturnType<typeof buildPageHierarchy>;
  selectionMode: 'single' | 'multiple';
  maxPages: number;
  effectivePolicy: ModelPolicyView | null;
  snapshot: RuntimeClassificationSnapshot | null | undefined;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): Promise<PageDecisionResult> {
  const {
    productContext,
    rawHierarchy,
    selectionMode,
    maxPages,
    effectivePolicy,
    snapshot,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  } = input;
    const llmResult = await llmAssignCategoryPages({
      productName: productContext.productName ?? 'Unknown Product',
      productDescription: productContext.productDescription ?? '',
      ocrSummary: buildPageLegacyOcrSummary(productContext),
      productType: productContext.productType ?? null,
      pages: rawHierarchy,
      selectionMode,
      maxPages,
      modelPolicy: effectivePolicy,
      snapshot,
    });

    return mapPageLegacyResult({
      llmResult,
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    });
}

type PageMultiCollectionOutcome =
  | { outcome: 'failed'; result: PageDecisionResult }
  | {
      outcome: 'collected';
      candidateProbabilities: Record<string, number>;
      modelCallIds: string[];
      evaluations: Array<{ pageId: string; pageName: string; prob: number; candidateIndex: number }>;
    };

/**
 * Collect multi-mode Noul answers in bounded batches (fail-closed per chunk).
 */
async function collectPageMultiEvaluations(input: {
  candidates: PageCandidateItem[];
  sku: string;
  productContext: PageDecisionProductContext;
  route: ReturnType<typeof resolveModelRoute>;
  jevConn: any;
  state: Record<string, unknown>;
  ctx: ModelCallContext;
  effectivePolicy: ModelPolicyView;
  assertHeld?: () => void;
  runId: string;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): Promise<PageMultiCollectionOutcome> {
  const {
    candidates,
    sku,
    productContext,
    route,
    jevConn,
    state,
    ctx,
    effectivePolicy,
    assertHeld,
    runId,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  } = input;
  // Exclude brand landing pages from Noul questions in multiple mode, as they are resolved
  // deterministically via brand-page shortcut rules and separated in provenance.
  const eligibleCandidates = candidates.filter(c => !c.pageName.toLowerCase().startsWith('brand -'));
  const noulQuestions = buildPageNoulQuestions(eligibleCandidates, sku, productContext);
  const candidateProbabilities: Record<string, number> = {};
  const modelCallIds: string[] = [];
  const evaluations: Array<{ pageId: string; pageName: string; prob: number; candidateIndex: number }> = [];

type PageMultiBatchOutcome =
  | { outcome: 'failed'; result: PageDecisionResult }
  | { outcome: 'collected'; evaluations: Array<{ pageId: string; pageName: string; prob: number; candidateIndex: number }> };

/**
 * Collect one multi-mode batch: bounded request, audit rows, and per-question
 * Noul evaluation. Chunk failures return the terminal failure result.
 */
/**
 * Open one multi-mode batch request: slicing, hashing, and the durable audit
 * start row.
 */
function openPageMultiBatchCall(input: {
  noulQuestions: ReturnType<typeof buildPageNoulQuestions>;
  offset: number;
  route: ReturnType<typeof resolveModelRoute>;
  state: Record<string, unknown>;
  ctx: ModelCallContext;
  effectivePolicy: ModelPolicyView;
  assertHeld?: () => void;
  runId: string;
}): {
  batch: ReturnType<typeof buildPageNoulQuestions>;
  request: { model: string; state: Record<string, unknown>; questions: Record<string, { type: 'noul'; instructions: string; criteria: { true: string; false: string } }> };
  callId: string;
} {
  const { noulQuestions, offset, route, state, ctx, effectivePolicy, assertHeld, runId } = input;
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

  const callId = openDecisionModelCall({
    runId,
    ctx,
    route,
    effectivePolicyDigest: effectivePolicy.policyDigest,
    promptHash,
  });

  return { batch, request, callId };
}

async function collectPageMultiBatch(input: {
  noulQuestions: ReturnType<typeof buildPageNoulQuestions>;
  offset: number;
  route: ReturnType<typeof resolveModelRoute>;
  state: Record<string, unknown>;
  ctx: ModelCallContext;
  effectivePolicy: ModelPolicyView;
  assertHeld?: () => void;
  runId: string;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  modelCallIds: string[];
}): Promise<PageMultiBatchOutcome> {
  const { noulQuestions, offset, route, state, ctx, effectivePolicy, assertHeld, runId, evidenceIds, supportingEvidenceIds, contradictingEvidenceIds, modelCallIds } = input;
  const evaluations: Array<{ pageId: string; pageName: string; prob: number; candidateIndex: number }> = [];
  const opened = openPageMultiBatchCall({
    noulQuestions,
    offset,
    route,
    state,
    ctx,
    effectivePolicy,
    assertHeld,
    runId,
  });
  const { batch, request, callId } = opened;
  modelCallIds.push(callId);

    const startedAt = Date.now();
    let result: any;

    try {
      assertHeld?.();
      result = await dispatchSystemOne(jevConn as any, request);
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
          batchedQuestions: Object.keys(request.questions),
          resolvedModel: result.returnedModel,
          basis: 'noul_probability',
        },
      });

      for (const q of batch) {
        const answer = requireNoulAnswer(result.answers, q.questionId);
        const pYes = answer.noul;
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

      return { outcome: 'failed', result: {
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
        } };
    }
  return { outcome: 'collected', evaluations };
}

  // Bounded batches: at most SYSTEMONE_MAX_QUESTIONS (32) questions per call
  for (let offset = 0; offset < noulQuestions.length; offset += SYSTEMONE_MAX_QUESTIONS) {
    const collected = await collectPageMultiBatch({
      noulQuestions,
      offset,
      route,
      state,
      ctx,
      effectivePolicy,
      assertHeld,
      runId,
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
      modelCallIds,
    });
    if (collected.outcome === 'failed') return collected;
    for (const evaluation of collected.evaluations) {
      evaluations.push(evaluation);
      candidateProbabilities[evaluation.pageId] = evaluation.prob;
    }
  }
  return {
    outcome: 'collected',
    candidateProbabilities,
    modelCallIds,
    evaluations,
  };

}

/**
 * Finalize multi-mode predictions: normalization, species filtering,
 * category correctness, then resolution.
 */
/**
 * Run category correctness validation for multi-mode page candidates.
 */
function validatePageMultiCorrectness(input: {
  sku: string;
  snapshot: RuntimeClassificationSnapshot | null | undefined;
  productSpecies: string[];
  productContext: PageDecisionProductContext;
  resolvedBrand: string | null;
  normalizedPages: Array<{ pageId: string; pageName: string }>;
  verifiedRecords: PageSnapshotRecord[];
}): ReturnType<typeof validateCategoryPageAssignment> {
  const { sku, snapshot, productSpecies, productContext, resolvedBrand, normalizedPages, verifiedRecords } = input;
  return validateCategoryPageAssignment({
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
}

/**
 * Abstain when deterministic normalization filtered out every proposed page.
 */
function checkNormalizedPagesEmpty(input: {
  normalizedPages: Array<{ pageId: string; pageName: string }>;
  qualifying: Array<{ pageId: string; pageName: string; prob: number; candidateIndex: number }>;
  candidateProbabilities: Record<string, number>;
  modelCallIds: string[];
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): PageDecisionResult | null {
  const { normalizedPages, qualifying, candidateProbabilities, modelCallIds, evidenceIds, supportingEvidenceIds, contradictingEvidenceIds } = input;
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
      derivation: buildNoulJudgmentDerivation(JEV_PAGE_QUESTION_ID, qualifying[0]?.prob ?? null, { abstentionCode: 'species_conflict' }),
      modelCallIds,
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    };
  }
  return null;
}

/**
 * Build the final multi-mode prediction result from normalized pages.
 */
function buildMultiPredictionResult(input: {
  normalizedPages: Array<{ pageId: string; pageName: string; confidence: number; isBrandShortcut?: boolean }>;
  qualifying: Array<{ pageId: string; pageName: string; prob: number; candidateIndex: number }>;
  candidateProbabilities: Record<string, number>;
  modelCallIds: string[];
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): PageDecisionResult {
  const { normalizedPages, qualifying, candidateProbabilities, modelCallIds, evidenceIds, supportingEvidenceIds, contradictingEvidenceIds } = input;
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
    derivation: buildNoulJudgmentDerivation(JEV_PAGE_QUESTION_ID, topProb),
  };
}

function finalizePageMultiPrediction(input: {
  qualifying: Array<{ pageId: string; pageName: string; prob: number; candidateIndex: number }>;
  candidateProbabilities: Record<string, number>;
  modelCallIds: string[];
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  pageIndex: Map<string, { id: string; name: string }>;
  resolvedBrand: string | null;
  productSpecies: string[];
  maxPages: number;
  sku: string;
  snapshot: RuntimeClassificationSnapshot | null | undefined;
  productContext: PageDecisionProductContext;
  verifiedRecords: PageSnapshotRecord[];
}): PageDecisionResult {
  const {
    qualifying,
    candidateProbabilities,
    modelCallIds,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
    pageIndex,
    resolvedBrand,
    productSpecies,
    maxPages,
    sku,
    snapshot,
    productContext,
    verifiedRecords,
  } = input;
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

  const speciesEmpty = checkNormalizedPagesEmpty({
    normalizedPages,
    qualifying,
    candidateProbabilities,
    modelCallIds,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  });
  if (speciesEmpty) return speciesEmpty;

  // Category correctness validation
  const correctnessResult = validatePageMultiCorrectness({
    sku,
    snapshot,
    productSpecies,
    productContext,
    resolvedBrand,
    normalizedPages,
    verifiedRecords,
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
      derivation: buildNoulJudgmentDerivation(JEV_PAGE_QUESTION_ID, qualifying[0]?.prob ?? null, { abstentionCode: 'validation_blocked' }),
      modelCallIds,
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    };
  }

  return buildMultiPredictionResult({
    normalizedPages,
    qualifying,
    candidateProbabilities,
    modelCallIds,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  });
}

/**
 * Execute multi-mode Noul flow: bounded collection, the 0.70 selection
 * policy with tie handling, then finalization.
 */
type PageMultiQualification =
  | { abstained: PageDecisionResult; qualifying?: undefined }
  | { abstained?: undefined; qualifying: Array<{ pageId: string; pageName: string; prob: number; candidateIndex: number }> };

/**
 * Apply the multiple-page selection policy: threshold filter, empty-outcome
 * mapping, deterministic ordering, and cardinality tie handling.
 */
function qualifyPageMultiEvaluations(input: {
  evaluations: Array<{ pageId: string; pageName: string; prob: number; candidateIndex: number }>;
  maxPages: number;
  candidateProbabilities: Record<string, number>;
  modelCallIds: string[];
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): PageMultiQualification {
  const { evaluations, maxPages, candidateProbabilities, modelCallIds, evidenceIds, supportingEvidenceIds, contradictingEvidenceIds } = input;
  // Evaluate multiple-page selection policy
  let qualifying = evaluations.filter(e => e.prob >= JEV_PAGE_MULTI_THRESHOLD);

  if (qualifying.length === 0) {
    const maxP = maxCandidateProbability(evaluations);
    const code = maxP < JEV_PAGE_MULTI_UNCERTAIN_FLOOR ? 'no_match' : 'insufficient_evidence';
    const reason = maxP < JEV_PAGE_MULTI_UNCERTAIN_FLOOR
      ? 'no_match: No Category Page in the catalog applies to this product with sufficient confidence.'
      : `insufficient_evidence: Product evidence is insufficient to assign Category Pages with confidence (highest probability ${maxP.toFixed(3)} is below threshold ${JEV_PAGE_MULTI_THRESHOLD.toFixed(2)}).`;

    return {
      abstained: {
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
        derivation: buildNoulJudgmentDerivation(JEV_PAGE_QUESTION_ID, maxP > 0 ? maxP : null, { abstentionCode: code }),
        modelCallIds,
        evidenceIds,
        supportingEvidenceIds,
        contradictingEvidenceIds,
      },
    };
  }

  // Sort qualifying candidates: P(yes) desc, then original candidateIndex asc
  qualifying = sortCandidatesByProbability(qualifying, q => q.candidateIndex);

  // Ambiguity / cardinality tie handling
  if (qualifying.length > maxPages) {
    const k = maxPages;
    const tiedProb = qualifying[k - 1].prob === qualifying[k].prob ? qualifying[k].prob : null;
    if (tiedProb !== null) {
      return {
        abstained: {
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
          derivation: buildNoulJudgmentDerivation(JEV_PAGE_QUESTION_ID, qualifying[0].prob, { abstentionCode: 'cardinality_limit_exceeded' }),
          modelCallIds,
          evidenceIds,
          supportingEvidenceIds,
          contradictingEvidenceIds,
        },
      };
    }
    qualifying = applyCardinalityLimit(qualifying, maxPages);
  }

  return { qualifying };
}

async function executePageMultiNoul(input: {
  candidates: PageCandidateItem[];
  sku: string;
  productContext: PageDecisionProductContext;
  route: ReturnType<typeof resolveModelRoute>;
  jevConn: any;
  state: Record<string, unknown>;
  ctx: ModelCallContext;
  effectivePolicy: ModelPolicyView;
  assertHeld?: () => void;
  runId: string;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  pageIndex: Map<string, { id: string; name: string }>;
  resolvedBrand: string | null;
  productSpecies: string[];
  maxPages: number;
  snapshot: RuntimeClassificationSnapshot | null | undefined;
  verifiedRecords: PageSnapshotRecord[];
}): Promise<PageDecisionResult> {
  const {
    candidates,
    sku,
    productContext,
    route,
    jevConn,
    state,
    ctx,
    effectivePolicy,
    assertHeld,
    runId,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
    pageIndex,
    resolvedBrand,
    productSpecies,
    maxPages,
    snapshot,
    verifiedRecords,
  } = input;
  const multiCollection = await collectPageMultiEvaluations({
    candidates,
    sku,
    productContext,
    route,
    jevConn,
    state,
    ctx,
    effectivePolicy,
    assertHeld,
    runId,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  });
  if (multiCollection.outcome === 'failed') return multiCollection.result;
  const { candidateProbabilities, modelCallIds, evaluations } = multiCollection;

  const qualified = qualifyPageMultiEvaluations({
    evaluations,
    maxPages,
    candidateProbabilities,
    modelCallIds,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  });
  if (qualified.abstained) return qualified.abstained;
  const qualifying = qualified.qualifying;

  return finalizePageMultiPrediction({
    qualifying,
    candidateProbabilities,
    modelCallIds,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
    pageIndex,
    resolvedBrand,
    productSpecies,
    maxPages,
    sku,
    snapshot,
    productContext,
    verifiedRecords,
  });

}

// ─── Canonical Decision Resolution ───────────────────────────────────────────

type PageGatingOutcome =
  | { abstained: PageDecisionResult; verifiedRecords?: undefined }
  | { abstained?: undefined; verifiedRecords: PageSnapshotRecord[] };

/**
 * Enforce page-decision gating: reviewed product-type authority plus a
 * verified store pages catalog. Returns the abstention or the records.
 */
/**
 * Enforce reviewed product-type authority for page proposals.
 */
function checkProductTypeAuthority(input: {
  snapshot: RuntimeClassificationSnapshot | null | undefined;
  reviewedProductTypeId?: string | null;
}): { abstained: PageDecisionResult } | { abstained?: undefined } {
  const { snapshot, reviewedProductTypeId } = input;
  // Page proposals require a reviewed Primary Product Type whenever product_type is an enabled target.
  const hasProductTypeTarget = snapshot?.curationTargets?.some(
    t => t.kind === 'product_type' && (t.enabled || t.mandatory),
  ) ?? false;

  if (hasProductTypeTarget && (reviewedProductTypeId === null || reviewedProductTypeId === undefined || reviewedProductTypeId === '')) {
    return { abstained: {
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
    } };
  }
  return {};
}

function checkPageGatingPrerequisites(input: {
  snapshot: RuntimeClassificationSnapshot | null | undefined;
  reviewedProductTypeId?: string | null;
  target: ResolvedTarget;
}): PageGatingOutcome {
  const { snapshot, reviewedProductTypeId, target } = input;
  // 1. Gating rule: Product Type authority prerequisite
  // Page proposals require a reviewed Primary Product Type whenever product_type is an enabled target.
  const typeAuthority = checkProductTypeAuthority({ snapshot, reviewedProductTypeId });
  if (typeAuthority.abstained) return typeAuthority;

  // 2. Gating rule: Verified store pages catalog prerequisite
  const verifiedRecords = snapshot?.pages.state === 'verified' ? snapshot.pages.records : [];
  if (!snapshot || snapshot.pages.state !== 'verified' || !target.options || target.options.length === 0 || verifiedRecords.length === 0) {
    return { abstained: {
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
    } };
  }

  return { verifiedRecords };
}

/**
 * Build the frozen page hierarchy and candidate items over verified records.
 */
function buildPageCandidates(input: {
  target: ResolvedTarget;
  verifiedRecords: PageSnapshotRecord[];
}): { rawHierarchy: ReturnType<typeof buildPageHierarchy>; candidates: PageCandidateItem[] } {
  const { target, verifiedRecords } = input;
  const rawHierarchy = buildPageHierarchy(target.options, verifiedRecords);
  const candidates: PageCandidateItem[] = rawHierarchy.map(p => ({
    pageId: p.id,
    pageName: p.name,
    parentId: verifiedRecords.find(r => r.pageId === p.id)?.parentPageId ?? null,
    parentName: p.parentName,
    path: p.parentName ? `${p.parentName} > ${p.name}` : p.name,
  }));
  return { rawHierarchy, candidates };
}

/**
 * Build the restricted page-evidence packet and structured product context.
 */
/**
 * Build the restricted page-evidence packet for one page decision.
 */
function buildPageEvidencePacketOnly(evidence: ClassificationEvidence[]): ReturnType<typeof buildPageEvidencePacket> {
  // Build restricted page-evidence packet
  const speciesVal = reviewedSpeciesValue(evidence);
  return buildPageEvidencePacket(evidence, {
    pageContextSourceFields: PAGE_CONTEXT_SOURCE_FIELDS,
    pageContextAttributeIds: PAGE_CONTEXT_ATTRIBUTE_IDS,
    sourceField: null,
    speciesValue: speciesVal,
  });
}

/**
 * Assemble the structured product context, preferring explicit overrides,
 * then reviewed values, then extracted evidence context.
 */
function assemblePageProductContext(input: {
  pageContextEvidence: ClassificationEvidence[];
  productContextOverride?: PageDecisionProductContext;
  reviewedProductTypeId?: string | null;
}): PageDecisionProductContext {
  const { pageContextEvidence, productContextOverride, reviewedProductTypeId } = input;
  const extractedContext = extractProductContext(pageContextEvidence, []);
  return {
    ...assemblePageIdentityContext({ productContextOverride, extractedContext }),
    ...assemblePageTaxonomyContext({ productContextOverride, reviewedProductTypeId, extractedContext }),
  };
}

/**
 * Identity fields for the page product context (override wins).
 */
function assemblePageIdentityContext(input: {
  productContextOverride?: PageDecisionProductContext;
  extractedContext: ReturnType<typeof extractProductContext>;
}): { productName: string; productDescription: string } {
  const { productContextOverride, extractedContext } = input;
  return {
    productName: productContextOverride?.productName ?? extractedContext.productName,
    productDescription: productContextOverride?.productDescription ?? extractedContext.productDescription,
  };
}

/**
 * Taxonomy fields for the page product context (override, then reviewed, then extracted).
 */
function assemblePageTaxonomyContext(input: {
  productContextOverride?: PageDecisionProductContext;
  reviewedProductTypeId?: string | null;
  extractedContext: ReturnType<typeof extractProductContext>;
}): { productType: string | null; ocrSummary: PageDecisionProductContext['ocrSummary'] } {
  const { productContextOverride, reviewedProductTypeId, extractedContext } = input;
  return {
    productType: productContextOverride?.productType ?? reviewedProductTypeId ?? extractedContext.productType,
    ocrSummary: productContextOverride?.ocrSummary ?? extractedContext.ocrSummary,
  };
}

function assemblePageDecisionContext(input: {
  evidence: ClassificationEvidence[];
  productContextOverride?: PageDecisionProductContext;
  reviewedProductTypeId?: string | null;
}): {
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  pageContextEvidence: ClassificationEvidence[];
  productContext: PageDecisionProductContext;
} {
  const { evidence, productContextOverride, reviewedProductTypeId } = input;
  const packet = buildPageEvidencePacketOnly(evidence);
  const evidenceIds = packet.evidenceIds;
  const supportingEvidenceIds = packet.supportingEvidenceIds;
  const contradictingEvidenceIds = packet.contradictingEvidenceIds;

  // Extract structured product context from restricted packet
  const pageContextEvidence = [
    ...packet.supporting,
    ...packet.contradicting,
    ...packet.context,
  ].sort((a, b) => (a.id ?? '').localeCompare(b.id ?? ''));

  const productContext = assemblePageProductContext({
    pageContextEvidence,
    productContextOverride,
    reviewedProductTypeId,
  });

  return { evidenceIds, supportingEvidenceIds, contradictingEvidenceIds, pageContextEvidence, productContext };
}

/**
 * Resolve the effective frozen model policy view (null when absent or malformed).
 */
function resolvePageEffectivePolicy(
  modelPolicy: ModelPolicyView | null | undefined,
  snapshot: RuntimeClassificationSnapshot | null | undefined,
): ModelPolicyView | null {
  return asEffectivePolicyView(modelPolicy ?? (snapshot ? snapshot.modelPolicy : null));
}

type PageDecisionRoute =
  | { outcome: 'denied'; result: PageDecisionResult }
  | { outcome: 'ready'; route: ReturnType<typeof resolveModelRoute> | null; conn: any; isSystemOne: boolean };

/**
 * Resolve the frozen page decision route. Policy denial returns a terminal
 * deterministic abstention.
 */
function resolvePageDecisionRoute(input: {
  effectivePolicy: ModelPolicyView | null;
  protectedOperation: ProtectedOperation;
  runId: string;
  snapshot: RuntimeClassificationSnapshot | null | undefined;
  assertHeld?: () => void;
  evidenceIds: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}): PageDecisionRoute {
  const { effectivePolicy, protectedOperation, runId, snapshot, assertHeld, evidenceIds, supportingEvidenceIds, contradictingEvidenceIds } = input;
  let route: ReturnType<typeof resolveModelRoute> | null = null;
  let conn: any = null;
  let isSystemOne = false;

  if (effectivePolicy) {
    try {
      const decision = resolveDecisionRouteForOperation(effectivePolicy, protectedOperation);
      route = decision.route;
      conn = decision.conn;
      isSystemOne = decision.isSystemOne;
    } catch (err) {
      if (err instanceof HeartbeatLostError) throw err;
      if (err instanceof ModelPolicyDeniedError) {
        assertHeld?.();
        insertPolicyDeniedTerminalCall({
          runId,
          stageName: 'category_page_proposals',
          operation: protectedOperation,
          provider: err.provider ?? null,
          snapshotHash: snapshot?.snapshotHash ?? '',
          modelPolicyDigest: effectivePolicy.policyDigest,
          promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS[protectedOperation],
          ruleVersion: RULE_VERSIONS[protectedOperation],
          errorMessage: err.message,
        });
        return { outcome: 'denied', result: {
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
        } };
      }
      throw err;
    }
  }
  return { outcome: 'ready', route, conn, isSystemOne };
}

/**
 * Prepare one page Jev execution: route check, connection, bounded state,
 * audit context, plan compatibility, and lookup scaffolding.
 */
/**
 * Resolve and verify the Jev connection for one page execution, returning
 * narrowed route and policy views.
 */
function resolvePageJevConnection(input: {
  conn: any;
  route: ReturnType<typeof resolveModelRoute> | null;
  effectivePolicy: ModelPolicyView | null;
  assertHeld?: () => void;
}): { jevConn: unknown; route: ReturnType<typeof resolveModelRoute>; effectivePolicy: ModelPolicyView } {
  const { conn, route, effectivePolicy, assertHeld } = input;
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
  return { jevConn, route, effectivePolicy };
}

function preparePageJevExecution(input: {
  route: ReturnType<typeof resolveModelRoute> | null;
  conn: any;
  effectivePolicy: ModelPolicyView | null;
  assertHeld?: () => void;
  pageContextEvidence: ClassificationEvidence[];
  sku: string;
  productContext: PageDecisionProductContext;
  runId: string;
  snapshot: RuntimeClassificationSnapshot | null | undefined;
  protectedOperation: ProtectedOperation;
  rawHierarchy: ReturnType<typeof buildPageHierarchy>;
}): {
  jevConn: unknown;
  state: Record<string, unknown>;
  ctx: ModelCallContext;
  pageIndex: Map<string, { id: string; name: string }>;
  resolvedBrand: string | null;
  productSpecies: string[];
  route: ReturnType<typeof resolveModelRoute>;
  effectivePolicy: ModelPolicyView;
} {
  const { route, conn, effectivePolicy, assertHeld, pageContextEvidence, sku, productContext, runId, snapshot, protectedOperation, rawHierarchy } = input;
  const connected = resolvePageJevConnection({ conn, route, effectivePolicy, assertHeld });
  const { jevConn, route: jevRoute, effectivePolicy: jevPolicy } = connected;

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
  return { jevConn, state, ctx, pageIndex, resolvedBrand, productSpecies, route: jevRoute, effectivePolicy: jevPolicy };
}

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

  const gating = checkPageGatingPrerequisites({ snapshot, reviewedProductTypeId, target });
  if (gating.abstained) return gating.abstained;
  const { verifiedRecords } = gating;

  // Build page hierarchy purely over frozen verified snapshot records
  const { rawHierarchy, candidates } = buildPageCandidates({ target, verifiedRecords });

  // Build restricted page-evidence packet plus structured product context
  const assembled = assemblePageDecisionContext({
    evidence,
    productContextOverride: params.productContext,
    reviewedProductTypeId,
  });
  const {
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
    pageContextEvidence,
    productContext,
  } = assembled;

  // 3. Resolve Model Policy Route
  const effectivePolicy = resolvePageEffectivePolicy(modelPolicy, snapshot);

  const routed = resolvePageDecisionRoute({
    effectivePolicy,
    protectedOperation,
    runId,
    snapshot,
    assertHeld,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
  });
  if (routed.outcome === 'denied') return routed.result;
  const { route, conn, isSystemOne } = routed;

  // 4. Fallback to existing chat LLM assigner if not routed to SystemOne
  if (!isSystemOne) {
    return executePageLegacyFallback({
      productContext,
      rawHierarchy,
      selectionMode,
      maxPages,
      effectivePolicy,
      snapshot,
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
    });
  }

  // ── TypeSafe Jev System One Execution ───────────────────────────────────────
  const prepared = preparePageJevExecution({
    route,
    conn,
    effectivePolicy,
    assertHeld,
    pageContextEvidence,
    sku,
    productContext,
    runId,
    snapshot,
    protectedOperation,
    rawHierarchy,
  });
  const { jevConn, state, ctx, pageIndex, resolvedBrand, productSpecies, route: jevRoute, effectivePolicy: jevPolicy } = prepared;

  // ── Single-Mode Choice Execution ───────────────────────────────────────────
  if (selectionMode === 'single') {
    return executePageSingleChoice({
      candidates,
      productContext,
      state,
      route: jevRoute,
      jevConn,
      ctx,
      effectivePolicy: jevPolicy,
      runId,
      assertHeld,
      evidenceIds,
      supportingEvidenceIds,
      contradictingEvidenceIds,
      pageIndex,
      resolvedBrand,
      productSpecies,
      sku,
      snapshot,
      verifiedRecords,
    });
  }

  return executePageMultiNoul({
    candidates,
    sku,
    productContext,
    route: jevRoute,
    jevConn,
    state,
    ctx,
    effectivePolicy: jevPolicy,
    assertHeld,
    runId,
    evidenceIds,
    supportingEvidenceIds,
    contradictingEvidenceIds,
    pageIndex,
    resolvedBrand,
    productSpecies,
    maxPages,
    snapshot,
    verifiedRecords,
  });
}/**
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

type CohortQuestionPlanEntry =
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

/**
 * Validate cohort page inputs: minimum products, non-empty pages, unique SKUs.
 * Returns an abstention map when invalid, otherwise null to continue.
 */
function validateCohortPageInputs(
  params: CoordinateCohortPagesWithJevParams,
  opts?: CoordinateCohortPagesWithJevOptions,
): Map<string, CohortPageMemberResult> | null {
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

  return null;
}

type CohortExecutionRoute =
  | { outcome: 'ready'; route: ReturnType<typeof resolveModelRoute>; conn: any; jevConn: any }
  | { outcome: 'abstained'; result: Map<string, CohortPageMemberResult> };

/**
 * Resolve the cohort frozen route, verify connection usability, and check the
 * audit-context plan. Denied/unavailable routes abstain the whole cohort.
 */
/**
 * Resolve the cohort frozen route (policy denial abstains the cohort).
 */
function resolveCohortExecutionRoute(input: {
  effectivePolicy: ModelPolicyView;
  operation: ProtectedOperation;
  params: CoordinateCohortPagesWithJevParams;
  opts?: CoordinateCohortPagesWithJevOptions;
}): { outcome: 'abstained'; result: Map<string, CohortPageMemberResult> } | { outcome: 'ready'; route: ReturnType<typeof resolveModelRoute>; conn: any } {
  const { effectivePolicy, operation, params, opts } = input;
  let route: ReturnType<typeof resolveModelRoute> | null;
  let conn: any;

  try {
    assertModelPolicyIntact(effectivePolicy);
    route = resolveModelRoute(effectivePolicy, operation, {
      getCredential: (p: string) => resolveSystemOneCredential(p),
      defaultBaseUrls: {
        typesafe: 'https://api.typesafe.ai/v1',
      },
    });
    const aiConfig = getFullAiRoutingConfig();
    conn = findSystemOneConnection(aiConfig.connections, route.provider);
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
      return { outcome: 'abstained', result: abstainAllPages(params.products, 'Cohort page LLM policy denied.') };
    }
    throw err;
  }

  return { outcome: 'ready', route: route!, conn };
}

/**
 * Verify the cohort connection is usable for dispatch (failures abstain).
 */
function checkCohortConnectionUsable(input: {
  conn: any;
  route: ReturnType<typeof resolveModelRoute>;
  effectivePolicy: ModelPolicyView;
  params: CoordinateCohortPagesWithJevParams;
  opts?: CoordinateCohortPagesWithJevOptions;
}): { outcome: 'abstained'; result: Map<string, CohortPageMemberResult> } | { outcome: 'ready'; jevConn: unknown } {
  const { conn, route, effectivePolicy, params, opts } = input;
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
    return { outcome: 'abstained', result: abstainAllPages(params.products, `TypeSafe connection not available: ${err.message}`) };
  }

  return { outcome: 'ready', jevConn };
}

function prepareCohortPageExecution(input: {
  params: CoordinateCohortPagesWithJevParams;
  opts?: CoordinateCohortPagesWithJevOptions;
  operation: ProtectedOperation;
  effectivePolicy: ModelPolicyView;
}): CohortExecutionRoute {
  const { params, opts, operation, effectivePolicy } = input;
  const routed = resolveCohortExecutionRoute({ effectivePolicy, operation, params, opts });
  if (routed.outcome === 'abstained') return { outcome: 'abstained', result: routed.result };
  const checked = checkCohortConnectionUsable({
    conn: routed.conn,
    route: routed.route,
    effectivePolicy,
    params,
    opts,
  });
  if (checked.outcome === 'abstained') return { outcome: 'abstained', result: checked.result };

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
  return { outcome: 'ready', route: routed.route, conn: routed.conn, jevConn: checked.jevConn };
}

/**
 * Construct the bounded cohort state: per-member snapshots plus the
 * execution type context, trimmed to the SystemOne state budget.
 */
/**
 * Map one cohort product to its bounded member state (lengths capped,
 * lists sorted for frozen determinism).
 */
function buildCohortMemberState(p: ProductLineItemSnapshot): {
  sku: string;
  name: string;
  webTitle: string | null;
  brand: string | null;
  description: string | null;
  species: string[];
  flavor: string | null;
  lifeStage: string | null;
  productForm: string | null;
  healthConcern: string[];
} {
  return {
    sku: p.sku,
    name: p.name.slice(0, 500),
    ...truncateCohortMemberStrings(p),
    ...sortCohortMemberLists(p),
    flavor: p.flavor ?? null,
    lifeStage: p.lifeStage ?? null,
    productForm: p.productForm ?? null,
  };
}

/**
 * Length-capped string fields for one cohort member state.
 */
function truncateCohortMemberStrings(p: ProductLineItemSnapshot): {
  webTitle: string | null;
  brand: string | null;
  description: string | null;
} {
  return {
    webTitle: (p.webTitle ?? '').slice(0, 500) || null,
    brand: (p.brand ?? '').slice(0, 200) || null,
    description: (p.description ?? '').slice(0, 1000) || null,
  };
}

/**
 * Sorted list fields for one cohort member state.
 */
function sortCohortMemberLists(p: ProductLineItemSnapshot): {
  species: string[];
  healthConcern: string[];
} {
  return {
    species: [...(p.species ?? [])].sort(),
    healthConcern: [...(p.healthConcern ?? [])].sort(),
  };
}

/**
 * Describe the cohort execution type context for bounded state.
 */
function describeCohortTypeContext(execContext: CoordinateCohortPagesWithJevOptions['executionTypeContext']): {
  id: string | null;
  label: string | null;
  confidence: number | null;
  outcome: string | null;
} {
  return {
    id: execContext?.id ?? null,
    label: execContext?.label ?? null,
    confidence: execContext?.confidence ?? null,
    outcome: execContext?.outcome ?? null,
  };
}

/**
 * Shrink cohort member states to fit the SystemOne state budget.
 */
function shrinkCohortStateMembers(
  baseState: Record<string, unknown>,
  memberStates: ReturnType<typeof buildCohortMemberState>[],
): void {
  fitStateToBudget(baseState, s => {
    s.members = memberStates.map(m => ({
      ...m,
      description: m.description ? m.description.slice(0, 300) : null,
    }));
  });
}

function buildCohortPageState(
  params: CoordinateCohortPagesWithJevParams,
  opts?: CoordinateCohortPagesWithJevOptions,
): { baseState: Record<string, unknown>; typeLabel: string | null; typeDesc: string } {
  // 5. Construct Bounded State
  const execContext = opts?.executionTypeContext;
  const typeLabel = execContext?.label ?? execContext?.id ?? null;
  const typeDesc = typeLabel ? `"${typeLabel}"` : 'product';

  const memberStates = params.products.map(buildCohortMemberState);

  const baseState: Record<string, unknown> = {
    groupId: params.groupId,
    productTypeContext: describeCohortTypeContext(execContext),
    members: memberStates,
  };

  shrinkCohortStateMembers(baseState, memberStates);

  return { baseState, typeLabel, typeDesc };
}

/**
 * Build one independent question per cohort member (Choice) or per
 * member-page pair (Noul), each judged from its own evidence only.
 */
function buildCohortPageQuestions(input: {
  products: CoordinateCohortPagesWithJevParams['products'];
  selectionMode: 'single' | 'multiple';
  candidates: PageCandidateItem[];
  typeLabel: string | null;
  typeDesc: string;
}): CohortQuestionPlanEntry[] {
  const { products, selectionMode, candidates, typeLabel, typeDesc } = input;
  const allQuestions: CohortQuestionPlanEntry[] = [];

  if (selectionMode === 'single') {
    for (const product of products) {
      const sanitizedSku = sanitizeQuestionIdSegment(product.sku);
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
    for (const product of products) {
      const sanitizedSku = sanitizeQuestionIdSegment(product.sku);
      for (let idx = 0; idx < eligibleCandidates.length; idx++) {
        const cand = eligibleCandidates[idx];
        const sanitizedPageId = sanitizeQuestionIdSegment(cand.pageId);
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

  return allQuestions;
}

type CohortDispatchOutcome =
  | { outcome: 'abstained'; result: Map<string, CohortPageMemberResult> }
  | { outcome: 'dispatched'; allAnswers: Record<string, any>; modelCallIds: string[] };

/**
 * Dispatch cohort question batches (<= 32 questions each) with per-batch
 * audit rows. A chunk dispatch failure abstains the whole cohort (two-level
 * atomicity); other chunks may still succeed.
 */
/**
 * Open one cohort batch request: record assembly, hashing, and the optional
 * durable audit start row (present only with a model-call context).
 */
/**
 * Insert the durable audit start row for one cohort batch request (present
 * only with a model-call context).
 */
function insertCohortBatchStart(input: {
  params: CoordinateCohortPagesWithJevParams;
  operation: ProtectedOperation;
  route: ReturnType<typeof resolveModelRoute>;
  effectivePolicy: ModelPolicyView;
  promptHash: string;
}): string | null {
  const { params, operation, route, effectivePolicy, promptHash } = input;
  return params.modelCall?.runId
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
}

function openCohortBatchCall(input: {
  batch: CohortQuestionPlanEntry[];
  baseState: Record<string, unknown>;
  route: ReturnType<typeof resolveModelRoute>;
  effectivePolicy: ModelPolicyView;
  operation: ProtectedOperation;
  params: CoordinateCohortPagesWithJevParams;
  opts?: CoordinateCohortPagesWithJevOptions;
}): {
  questionsRecord: Record<string, any>;
  request: { model: string; state: Record<string, unknown>; questions: Record<string, any> };
  callId: string | null;
} {
  const { batch, baseState, route, effectivePolicy, operation, params, opts } = input;
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
  const callId = insertCohortBatchStart({
    params,
    operation,
    route,
    effectivePolicy,
    promptHash,
  });
  return { questionsRecord, request, callId };
}

/**
 * Run one prepared cohort batch dispatch with audit completion and answer
 * collection. Failures abstain the whole cohort (two-level atomicity).
 */
/**
 * Collect one dispatched cohort batch's answers (strict per-question typing;
 * mismatches throw into fail-closed handling).
 */
function collectCohortBatchAnswers(input: {
  batch: CohortQuestionPlanEntry[];
  dispatchRes: { answers: Record<string, any> };
  allAnswers: Record<string, any>;
}): void {
  const { batch, dispatchRes, allAnswers } = input;
  for (const q of batch) {
    const ans = dispatchRes.answers[q.questionId];
    if (!ans || ans.type !== q.payload.type) {
      throw new Error(`Expected ${q.payload.type} answer for question "${q.questionId}", got "${ans?.type ?? 'missing'}".`);
    }
    allAnswers[q.questionId] = ans;
  }
}

/**
 * Record one failed cohort batch dispatch and abstain the cohort chunk.
 */
function failCohortBatchDispatch(input: {
  err: unknown;
  callId: string | null;
  startedAt: number;
  opts?: CoordinateCohortPagesWithJevOptions;
  params: CoordinateCohortPagesWithJevParams;
}): CohortDispatchOutcome {
  const { err, callId, startedAt, opts, params } = input;
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
  return { outcome: 'abstained', result: abstainAllPages(params.products, `TypeSafe Jev dispatch failed: ${err instanceof Error ? err.message : String(err)}`) };
}

async function runCohortBatchDispatch(input: {
  batch: CohortQuestionPlanEntry[];
  request: { model: string; state: Record<string, unknown>; questions: Record<string, any> };
  jevConn: any;
  callId: string | null;
  startedAt: number;
  opts?: CoordinateCohortPagesWithJevOptions;
  questionsRecord: Record<string, any>;
  allAnswers: Record<string, any>;
  params: CoordinateCohortPagesWithJevParams;
}): Promise<CohortDispatchOutcome> {
  const { batch, request, jevConn, callId, startedAt, opts, questionsRecord, allAnswers, params } = input;
  let dispatchRes: any;

  try {
    opts?.assertHeld?.();
    dispatchRes = await dispatchSystemOne(jevConn as any, request);
    opts?.assertHeld?.();

    assertSystemOneModelMatch(request.model, dispatchRes.returnedModel);

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

    collectCohortBatchAnswers({ batch, dispatchRes, allAnswers });
  } catch (err: any) {
    return failCohortBatchDispatch({
      err,
      callId,
      startedAt,
      opts,
      params,
    });
  }
  return { outcome: 'dispatched', allAnswers, modelCallIds: [] };
}

async function dispatchCohortPageBatches(input: {
  questionBatches: CohortQuestionPlanEntry[][];
  baseState: Record<string, unknown>;
  route: ReturnType<typeof resolveModelRoute>;
  jevConn: any;
  effectivePolicy: ModelPolicyView;
  operation: ProtectedOperation;
  params: CoordinateCohortPagesWithJevParams;
  opts?: CoordinateCohortPagesWithJevOptions;
}): Promise<CohortDispatchOutcome> {
  const { questionBatches, baseState, route, jevConn, effectivePolicy, operation, params, opts } = input;
  const allAnswers: Record<string, any> = {};
  const modelCallIds: string[] = [];
  for (const batch of questionBatches) {
    const opened = openCohortBatchCall({
      batch,
      baseState,
      route,
      effectivePolicy,
      operation,
      params,
      opts,
    });
    const { questionsRecord, request, callId } = opened;
    if (callId) {
      modelCallIds.push(callId);
    }

    const startedAt = Date.now();

    const dispatched = await runCohortBatchDispatch({
      batch,
      request,
      jevConn,
      callId,
      startedAt,
      opts,
      questionsRecord,
      allAnswers,
      params,
    });
    if (dispatched.outcome === 'abstained') return { outcome: 'abstained', result: dispatched.result };
  }

  return { outcome: 'dispatched', allAnswers, modelCallIds };
}

/**
 * Evaluate one cohort member's single-mode Choice answer with singleton
 * semantics: abstentions, mapping, the 0.50 floor, normalization,
 * species filtering, and category correctness.
 */
/**
 * Map one cohort member's single-mode answer to its choice key and
 * probability, abstaining on missing answers.
 */
function mapCohortSingleAnswer(input: {
  q: Extract<CohortQuestionPlanEntry, { kind: 'choice' }>;
  allAnswers: Record<string, any>;
}): { abstained: CohortPageMemberResult } | { chosenKey: string; selectedProbability: number } {
  const { q, allAnswers } = input;
  const ans = allAnswers[q.questionId];
  if (!ans || ans.type !== 'choice') {
    return { abstained: { status: 'abstained', reason: `Missing answer for question ${q.questionId}` } };
  }

  const chosenKey = ans.choice;
  const selectedProbability = ans.probabilities[chosenKey] ?? 0;
  return { chosenKey, selectedProbability };
}

/**
 * Normalize one cohort member's single-mode pages (deterministic rules),
 * abstaining when everything is filtered out.
 */
function normalizeCohortSinglePages(input: {
  candidate: PageCandidateItem;
  selectedProbability: number;
  pageIndex: Map<string, { id: string; name: string }>;
  product: ProductLineItemSnapshot;
}): { abstained: CohortPageMemberResult } | { normalizedPages: Array<{ pageId: string; pageName: string; confidence: number; isBrandShortcut?: boolean }> } {
  const { candidate, selectedProbability, pageIndex, product } = input;
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
    return { abstained: { status: 'abstained', reason: 'Proposed category page filtered out by deterministic rules (e.g. cross-species conflict).' } };
  }
  return { normalizedPages };
}

/**
 * Validate one normalized single-mode cohort member and build its final
 * assignment result.
 */
function finalizeCohortSingleAssignment(input: {
  product: ProductLineItemSnapshot;
  normalizedPages: Array<{ pageId: string; pageName: string; confidence: number; isBrandShortcut?: boolean }>;
  candidates: PageCandidateItem[];
  snapshotHash: string;
  typeLabel: string | null;
  modelCallIds: string[];
}): CohortPageMemberResult {
  const { product, normalizedPages, candidates, snapshotHash, typeLabel, modelCallIds } = input;
  // Category correctness validation
  const correctness = validateCategoryPageAssignment({
    member: {
      onboardingItemId: product.sku,
      frozenEvidenceHash: snapshotHash,
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
    activePageImportHash: snapshotHash,
  });

  if (!correctness.valid || correctness.outcome === 'blocked') {
    return {
      status: 'abstained',
      reason: correctness.reason ?? 'Category page validation failed.',
    };
  }

  return {
    status: 'assigned',
    pages: normalizedPages.map(p => ({
      pageId: p.pageId,
      pageName: p.pageName,
      confidence: p.confidence,
      isBrandShortcut: p.isBrandShortcut,
    })),
    modelCallIds,
    source: 'typesafe',
  };
}

function evaluateCohortSingleMember(input: {
  q: Extract<CohortQuestionPlanEntry, { kind: 'choice' }>;
  allAnswers: Record<string, any>;
  modelCallIds: string[];
  candidates: PageCandidateItem[];
  pageIndex: Map<string, { id: string; name: string }>;
  snapshotHash: string;
  typeLabel: string | null;
}): CohortPageMemberResult {
  const { q, allAnswers, modelCallIds, candidates, pageIndex, snapshotHash, typeLabel } = input;
  const product = q.product;
      const mapped = mapCohortSingleAnswer({ q, allAnswers });
      if ('abstained' in mapped) return mapped.abstained;
      const { chosenKey, selectedProbability } = mapped;

      if (chosenKey === NO_MATCH_CHOICE_KEY) {
        return {
          status: 'abstained',
          reason: 'no_match: No matching Category Page in the catalog applies to this product.',
        };
      }

      if (chosenKey === INSUFFICIENT_EVIDENCE_CHOICE_KEY) {
        return {
          status: 'abstained',
          reason: 'insufficient_evidence: Product evidence is insufficient to determine the correct Category Page.',
        };
      }

      const pageId = q.questionPlan.keyToIdMap.get(chosenKey);
      const candidate = candidates.find(c => c.pageId === pageId);
      if (!pageId || !candidate) {
        return {
          status: 'abstained',
          reason: `Selected choice key "${chosenKey}" could not be mapped to a known candidate page.`,
        };
      }

      if (selectedProbability < JEV_PAGE_SINGLE_THRESHOLD) {
        return {
          status: 'abstained',
          reason: `insufficient_evidence: Selected category page probability ${selectedProbability.toFixed(3)} is below required threshold ${JEV_PAGE_SINGLE_THRESHOLD.toFixed(2)}.`,
        };
      }

      const normalized = normalizeCohortSinglePages({
        candidate,
        selectedProbability,
        pageIndex,
        product,
      });
      if ('abstained' in normalized) return normalized.abstained;
      const normalizedPages = normalized.normalizedPages;

      return finalizeCohortSingleAssignment({
        product,
        normalizedPages,
        candidates,
        snapshotHash,
        typeLabel,
        modelCallIds,
      });
}

/**
 * Evaluate one cohort member's multi-mode Noul answers with singleton
 * semantics: collection, the 0.70 floor, tie handling, brand shortcut,
 * normalization, and category correctness.
 */
/**
 * Collect one cohort member's per-page Noul probabilities (missing answers
 * score zero, matching singleton multi semantics).
 */
function collectCohortMemberEvaluations(input: {
  entries: Extract<CohortQuestionPlanEntry, { kind: 'noul' }>[];
  allAnswers: Record<string, any>;
}): Array<{ pageId: string; pageName: string; prob: number; candidateIndex: number }> {
  const { entries, allAnswers } = input;
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

  return evaluations;
}

type CohortMemberQualification =
  | { outcome: 'abstained'; result: CohortPageMemberResult }
  | { outcome: 'qualified'; selected: Array<{ pageId: string; pageName: string; prob: number; candidateIndex: number }> };

/**
 * Apply the cohort multi-mode selection policy: threshold filter with
 * empty-outcome mapping, deterministic ordering, tie handling, and the
 * cardinality limit.
 */
function qualifyCohortMemberEvaluations(input: {
  evaluations: Array<{ pageId: string; pageName: string; prob: number; candidateIndex: number }>;
  maxPages: number;
}): CohortMemberQualification {
  const { evaluations, maxPages } = input;
  const qualifying = evaluations.filter(e => e.prob >= JEV_PAGE_MULTI_THRESHOLD);

  if (qualifying.length === 0) {
    const maxP = maxCandidateProbability(evaluations);
    const reason = maxP < JEV_PAGE_MULTI_UNCERTAIN_FLOOR
      ? 'no_match: No Category Page in the catalog applies to this product with sufficient confidence.'
      : `insufficient_evidence: Product evidence is insufficient to assign Category Pages with confidence (highest probability ${maxP.toFixed(3)} is below threshold ${JEV_PAGE_MULTI_THRESHOLD.toFixed(2)}).`;

    return { outcome: 'abstained', result: { status: 'abstained', reason } };
  }

  const sorted = sortCandidatesByProbability(qualifying, q => q.candidateIndex);

  if (sorted.length > maxPages) {
    const k = maxPages;
    if (sorted[k - 1].prob === sorted[k].prob) {
      const tiedProb = sorted[k].prob;
      return {
        outcome: 'abstained',
        result: {
          status: 'abstained',
          reason: `cardinality_limit_exceeded: Ambiguity at cardinality limit (${maxPages}): multiple candidates share identical probability (${tiedProb.toFixed(3)}) at the selection boundary.`,
        },
      };
    }
  }

  const selected = applyCardinalityLimit(sorted, maxPages);
  return { outcome: 'qualified', selected };
}

/**
 * Build one cohort member's initial page list: selected pages plus the brand
 * landing page shortcut when applicable.
 */
function buildCohortInitialPages(input: {
  selected: Array<{ pageId: string; pageName: string; prob: number; candidateIndex: number }>;
  product: ProductLineItemSnapshot;
  pageIndex: Map<string, { id: string; name: string }>;
}): Array<{ pageId: string; pageName: string; confidence: number; isBrandShortcut: boolean }> {
  const { selected, product, pageIndex } = input;
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

  return initialPages;
}

function evaluateCohortMultiMember(input: {
  product: ProductLineItemSnapshot;
  entries: Extract<CohortQuestionPlanEntry, { kind: 'noul' }>[];
  allAnswers: Record<string, any>;
  modelCallIds: string[];
  pageIndex: Map<string, { id: string; name: string }>;
  maxPages: number;
  snapshotHash: string;
  typeLabel: string | null;
  candidates: PageCandidateItem[];
}): CohortPageMemberResult {
  const {
    product,
    entries,
    allAnswers,
    modelCallIds,
    pageIndex,
    maxPages,
    snapshotHash,
    typeLabel,
    candidates,
  } = input;
      const evaluations = collectCohortMemberEvaluations({ entries, allAnswers });

      const qualified = qualifyCohortMemberEvaluations({ evaluations, maxPages });
      if (qualified.outcome === 'abstained') return qualified.result;
      const selected = qualified.selected;
      const initialPages = buildCohortInitialPages({ selected, product, pageIndex });

      const normalized = normalizePageAssignments(
        initialPages,
        pageIndex,
        product.brand ?? null,
        product.species ?? [],
        maxPages,
        'multiple',
      );

      if (normalized.length === 0) {
        return {
          status: 'abstained',
          reason: 'Proposed category pages filtered out by deterministic rules.',
        };
      }

      const correctness = validateCategoryPageAssignment({
        member: {
          onboardingItemId: product.sku,
          frozenEvidenceHash: snapshotHash,
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
        activePageImportHash: snapshotHash,
      });

      if (!correctness.valid || correctness.outcome === 'blocked') {
        return {
          status: 'abstained',
          reason: correctness.reason ?? 'Category page validation failed.',
        };
      }

      return {
        status: 'assigned',
        pages: normalized.map(p => ({
          pageId: p.pageId,
          pageName: p.pageName,
          confidence: p.confidence,
          isBrandShortcut: p.isBrandShortcut,
        })),
        modelCallIds,
        source: 'typesafe',
      };}

/**
 * Resolve the cohort protected operation and assert model-call provenance.
 */
function resolveCohortOperation(
  params: CoordinateCohortPagesWithJevParams,
  opts?: CoordinateCohortPagesWithJevOptions,
): ProtectedOperation {
  const operation = opts?.protectedOperation ?? 'cohort_page_assignment';
  if (params.modelCall && params.modelCall.operation !== operation) {
    throw new Error(
      `Cohort page coordination provenance mismatch: model-call context operation "${params.modelCall.operation}" ` +
        `differs from the effective protected operation "${operation}".`,
    );
  }
  return operation;
}

type CohortCandidatesOutcome =
  | { abstained: Map<string, CohortPageMemberResult>; candidates?: undefined; pageIndex?: undefined }
  | { abstained?: undefined; candidates: PageCandidateItem[]; pageIndex: Map<string, { id: string; name: string }> };

/**
 * Build cohort candidates over configured pages with the single-mode
 * candidate-limit guard.
 */
function buildCohortCandidates(params: CoordinateCohortPagesWithJevParams): CohortCandidatesOutcome {
  const candidates: PageCandidateItem[] = params.pages.map(p => ({
    pageId: p.id,
    pageName: p.name,
    parentId: null,
    parentName: p.parentName,
    path: p.parentName ? `${p.parentName} > ${p.name}` : p.name,
  }));
  const pageIndex = new Map(params.pages.map(p => [p.name, { id: p.id, name: p.name }]));

  if (params.selectionMode === 'single' && candidates.length > MAX_ORDINARY_PAGE_CANDIDATES) {
    return { abstained: abstainAllPages(
      params.products,
      `candidate_limit_exceeded: Candidate Category Pages (${candidates.length}) exceed maximum Choice capacity of ${MAX_ORDINARY_PAGE_CANDIDATES}. First-N clipping is forbidden.`,
    ) };
  }
  return { candidates, pageIndex };
}

/**
 * Partition cohort questions into batches of at most 32.
 */
function partitionCohortQuestions(allQuestions: CohortQuestionPlanEntry[]): CohortQuestionPlanEntry[][] {
  const questionBatches: CohortQuestionPlanEntry[][] = [];
  for (let i = 0; i < allQuestions.length; i += SYSTEMONE_MAX_QUESTIONS) {
    questionBatches.push(allQuestions.slice(i, i + SYSTEMONE_MAX_QUESTIONS));
  }
  return questionBatches;
}

/**
 * Evaluate every cohort member with singleton Choice/Noul semantics.
 */
/**
 * Evaluate all cohort members in multiple mode, grouping Noul questions by SKU.
 */
function evaluateCohortMultiMembers(input: {
  params: CoordinateCohortPagesWithJevParams;
  allQuestions: CohortQuestionPlanEntry[];
  allAnswers: Record<string, any>;
  modelCallIds: string[];
  candidates: PageCandidateItem[];
  pageIndex: Map<string, { id: string; name: string }>;
  typeLabel: string | null;
  resultMap: Map<string, CohortPageMemberResult>;
}): void {
  const { params, allQuestions, allAnswers, modelCallIds, candidates, pageIndex, typeLabel, resultMap } = input;
  // Multiple mode
  const noulEntries = allQuestions as Extract<CohortQuestionPlanEntry, { kind: 'noul' }>[];
  const noulBySku = new Map<string, typeof noulEntries>();
  for (const entry of noulEntries) {
    const list = noulBySku.get(entry.sku) ?? [];
    list.push(entry);
    noulBySku.set(entry.sku, list);
  }

  for (const product of params.products) {
    const entries = noulBySku.get(product.sku) ?? [];
    resultMap.set(product.sku, evaluateCohortMultiMember({
      product,
      entries,
      allAnswers,
      modelCallIds,
      pageIndex,
      maxPages: params.maxPages,
      snapshotHash: params.snapshot?.snapshotHash ?? '',
      typeLabel,
      candidates,
    }));
  }
}

function evaluateCohortMembers(input: {
  params: CoordinateCohortPagesWithJevParams;
  allQuestions: CohortQuestionPlanEntry[];
  allAnswers: Record<string, any>;
  modelCallIds: string[];
  candidates: PageCandidateItem[];
  pageIndex: Map<string, { id: string; name: string }>;
  typeLabel: string | null;
}): Map<string, CohortPageMemberResult> {
  const { params, allQuestions, allAnswers, modelCallIds, candidates, pageIndex, typeLabel } = input;
  const resultMap = new Map<string, CohortPageMemberResult>();

  if (params.selectionMode === 'single') {
    for (const q of allQuestions as Extract<CohortQuestionPlanEntry, { kind: 'choice' }>[]) {
      resultMap.set(q.product.sku, evaluateCohortSingleMember({
        q,
        allAnswers,
        modelCallIds,
        candidates,
        pageIndex,
        snapshotHash: params.snapshot?.snapshotHash ?? '',
        typeLabel,
      }));
    }
  } else {
    evaluateCohortMultiMembers({
      params,
      allQuestions,
      allAnswers,
      modelCallIds,
      candidates,
      pageIndex,
      typeLabel,
      resultMap,
    });
  }

  return resultMap;
}

export async function coordinateCohortPagesWithJev(
  params: CoordinateCohortPagesWithJevParams,
  opts?: CoordinateCohortPagesWithJevOptions,
): Promise<Map<string, CohortPageMemberResult>> {
  const invalidCohort = validateCohortPageInputs(params, opts);
  if (invalidCohort) return invalidCohort;

  // 2. Protected operation resolution and provenance assertion
  const operation = resolveCohortOperation(params, opts);

  // 3. Resolve Model Policy Route
  const effectivePolicy = asEffectivePolicyView(
    params.modelPolicy ?? (params.snapshot ? params.snapshot.modelPolicy : null),
  );

  if (!effectivePolicy) {
    opts?.assertHeld?.();
    return abstainAllPages(params.products, 'No category_page_assignment LLM is configured.');
  }

  const cohortExecution = prepareCohortPageExecution({ params, opts, operation, effectivePolicy });
  if (cohortExecution.outcome === 'abstained') return cohortExecution.result;
  const { route, jevConn } = cohortExecution;

  // 4. Candidate verification and candidate-limit check
  const cohortCandidates = buildCohortCandidates(params);
  if (cohortCandidates.abstained) return cohortCandidates.abstained;
  const { candidates, pageIndex } = cohortCandidates;

  const { baseState, typeLabel, typeDesc } = buildCohortPageState(params, opts);

  // 6. Build Question Plans

  const allQuestions = buildCohortPageQuestions({
    products: params.products,
    selectionMode: params.selectionMode,
    candidates,
    typeLabel,
    typeDesc,
  });

  // 7. Request Partitioning (Batches <= 32 questions)
  const questionBatches = partitionCohortQuestions(allQuestions);

  const cohortDispatch = await dispatchCohortPageBatches({
    questionBatches,
    baseState,
    route,
    jevConn,
    effectivePolicy,
    operation,
    params,
    opts,
  });
  if (cohortDispatch.outcome === 'abstained') return cohortDispatch.result;
  const { allAnswers, modelCallIds } = cohortDispatch;

  // Crash seam: fires after the coordinated call resolves, before returning to caller
  await opts?.afterCoordinatedCall?.();

  // 8. Member Judgment Evaluation (Singleton Choice/Noul semantics per member)
  return evaluateCohortMembers({
    params,
    allQuestions,
    allAnswers,
    modelCallIds,
    candidates,
    pageIndex,
    typeLabel,
  });
}
