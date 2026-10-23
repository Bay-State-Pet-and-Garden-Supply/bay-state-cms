/**
 * Evidence-backed name decision boundary (issue #365).
 *
 * Canonical TypeSafe Choice boundary for full product names, consumed
 * identically by singleton curation and cohort members. Enforces:
 * - Deterministic candidate construction from eligible per-SKU evidence only.
 * - Deduplication + zero-call deterministic choice for single/stylistic cases.
 * - Bounded Choice over at most 16 complete candidates + no_match /
 *   insufficient_evidence; the model returns a supplied candidate ID only.
 * - Persisted nameDecision provenance: components/spans, rule/input/title
 *   hashes, true producer, actual call IDs.
 *
 * Sibling context is presentation-only (Choice state context, never a
 * candidate input) — another SKU's facts can never be inherited into the
 * name. Follows the `product-type-decision.ts` boundary shape so audit,
 * lease, retry, and guard semantics stay uniform.
 */

import { TYPESAFE_EVALUATED_MODEL } from '../ai/systemone-transport';
import { assertConnectionEnabledForDispatch } from '../ai/provider-connections';
import { completeModelCall } from '../db/repositories/classification-model-call-repo';
import { hashCanonicalJson, sha256Hex } from '../shared/stable-id';
import type { NameDecision } from '../shared/schemas/onboarding';
import type { ClassificationEvidence } from '../shared/schemas/classification';
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
  SYSTEMONE_SINGLE_CHOICE_MIN_PROBABILITY,
  asEffectivePolicyView,
  choiceKeyToCanonicalId,
  fitStateToBudget,
  insertPolicyDeniedTerminalCall,
  openSingleChoiceRequest,
  resolveDecisionRouteForOperation,
  runSingleChoiceDispatch,
  truncateSnippets,
} from './systemone-decision-core';
import {
  MAX_NAME_CANDIDATES,
  NAME_NORMALIZATION_VERSION as NAME_CANDIDATES_NORMALIZATION_VERSION,
  SPECIES_IDENTITY_WORDS,
  buildNameCandidates,
  deterministicNameChoice,
  type NameCandidateInput,
  type NameEvidenceText,
} from './name-candidates';
import { knownVariantTokens, variantTokenPresentInTitle } from '../onboarding/title-prompt-template';
export { NAME_CANDIDATES_NORMALIZATION_VERSION as NAME_NORMALIZATION_VERSION };
// ─── Versioned constants ─────────────────────────────────────────────────────

export const NAME_SELECTION_QUESTION_ID = 'evidence_backed_name';
const NO_MATCH_CHOICE_KEY = 'no_match';
const INSUFFICIENT_EVIDENCE_CHOICE_KEY = 'insufficient_evidence';

/** Evaluated starting probability floor for name Choice selection. */
export const NAME_SELECTION_MIN_PROBABILITY = SYSTEMONE_SINGLE_CHOICE_MIN_PROBABILITY; // 0.50

/** Candidate bound for typed selection (overflow is visible, never clipped silently). */
export const NAME_SELECTION_CANDIDATE_LIMIT = MAX_NAME_CANDIDATES; // 16

const now = () => new Date().toISOString();

// ─── Types ───────────────────────────────────────────────────────────────────

export type NameDecisionStatus = 'resolved' | 'abstained' | 'failed';

export interface NameSelectionParams {
  evidence: ClassificationEvidence[];
  spans: NameEvidenceText[];
  brand: string | null;
  sku: string;
  runId: string;
  snapshot?: RuntimeClassificationSnapshot | null;
  modelPolicy?: ModelPolicyView | null;
  assertHeld?: () => void;
  /** Sibling titles for presentation context only (never candidate inputs). */
  siblingTitles?: string[];
  /**
   * Operator-corrected title: reviewer authority, recorded as `manual`
   * provenance — never presented as a typed selection.
   */
  manualTitle?: string | null;
}

/**
 * Single producer mapper for name-selection results (the 3+ call sites in
 * titles/product-curator/title-consolidation must not re-derive the same
 * ternary): a TypeSafe Choice producer maps to the durable `typesafe`
 * source, everything else maps to `deterministic` (manual provenance never
 * reaches this mapper — operator corrections resolve as `manual` upstream).
 */
export function nameSourceForProducer(producer: NameSelectionResult['producer']): 'typesafe' | 'deterministic' {
  return producer === 'typesafe' ? 'typesafe' : 'deterministic';
}

export interface NameSelectionResult {
  status: NameDecisionStatus;
  title: string | null;
  selectedCandidateId: string | null;
  candidates: NameCandidateInput[];
  overflow: boolean;
  producer: 'typesafe' | 'deterministic' | 'manual' | null;
  selectionOutcome: 'selected' | 'no_match' | 'insufficient_evidence' | null;
  abstentionCode?:
    | 'no_match'
    | 'insufficient_evidence'
    | 'low_probability'
    | 'candidate_limit_exceeded'
    | 'service_failure'
    | 'policy_denied'
    | 'missing_evidence'
    | 'conflict';
  abstentionReason?: string | null;
  modelCallIds: string[];
  evidenceIds: string[];
  selectedEvidenceIds: string[];
  selectedComponents: string[];
  error?: unknown;
}

export interface NameChoiceQuestionPlan {
  questionId: string;
  instructions: string;
  criteria: Record<string, string>;
  keyToIdMap: Map<string, string>;
  idToKeyMap: Map<string, string>;
}

// ─── Question builder ────────────────────────────────────────────────────────

export function buildNameChoiceQuestion(
  candidates: NameCandidateInput[],
): NameChoiceQuestionPlan {
  const criteria: Record<string, string> = {};
  const keyToIdMap = new Map<string, string>();
  const idToKeyMap = new Map<string, string>();
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const id = `name_${i + 1}`;
    const key = `name_opt_${i}`;
    keyToIdMap.set(key, id);
    idToKeyMap.set(id, key);
    criteria[key] = `Complete product name: "${candidate.title}" (built from: ${candidate.components.join('; ').slice(0, 300)})`;
  }
  criteria[NO_MATCH_CHOICE_KEY] =
    'None of the supplied complete names correctly identifies this product from its own evidence.';
  criteria[INSUFFICIENT_EVIDENCE_CHOICE_KEY] =
    'The eligible evidence is insufficient or ambiguous to choose among the supplied names with confidence.';
  const instructions =
    'Select the ONE supplied complete product name that best identifies THIS product from its own eligible evidence. ' +
    'Return a supplied candidate ID only — never invent a new title, component, or wording. ' +
    'Preserve brand-first order and quantity-last detail; a candidate missing evidenced brand or variant detail must not be selected. ' +
    'Conflicting package sizes are never combined: when no candidate is supportable, select "no_match"; ' +
    'when the evidence cannot decide, select "insufficient_evidence".';
  return { questionId: NAME_SELECTION_QUESTION_ID, instructions, criteria, keyToIdMap, idToKeyMap };
}

interface BoundedNameState {
  sku: string;
  brand: string | null;
  candidates: Array<{ id: string; title: string }>;
  snippets: string[];
  evidenceCount: number;
  siblingContext?: string | null;
}

function buildNameState(
  evidence: ClassificationEvidence[],
  sku: string,
  brand: string | null,
  candidates: NameCandidateInput[],
  siblingTitles?: string[],
): BoundedNameState {
  const snippets: string[] = [];
  for (const e of evidence) {
    const val = typeof e.value === 'string' ? e.value : (e.snippet ?? '');
    if (val && snippets.length < 15) snippets.push(val.slice(0, 500));
  }
  const state: BoundedNameState = {
    sku,
    brand,
    candidates: candidates.map((c, i) => ({ id: `name_${i + 1}`, title: c.title })),
    snippets: truncateSnippets(snippets),
    evidenceCount: evidence.length,
  };
  if (siblingTitles && siblingTitles.length > 0) {
    state.siblingContext =
      `Sibling presentation context (never a fact source): ${siblingTitles.slice(0, 3).join('; ')}. ` +
      `Decide from this product's own evidence only.`;
  }
  fitStateToBudget(state, s => {
    s.snippets = [];
    s.siblingContext = null;
  });
  return state;
}

function buildNameCallContext(input: {
  runId: string;
  snapshot: RuntimeClassificationSnapshot | null | undefined;
}): ModelCallContext {
  const { runId, snapshot } = input;
  return {
    runId,
    snapshotHash: snapshot?.snapshotHash ?? '',
    stage: 'name_consolidation',
    operation: 'title_consolidation',
    attempt: 1,
    promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS.title_consolidation,
    ruleVersion: RULE_VERSIONS.title_consolidation,
  };
}

// ─── NameDecision currentness ───────────────────────────────────────────────

/**
 * Recompute the eligible-input hash for a span bundle (same canonical shape
 * as `toNameDecision`). Exported so the review gate can verify a persisted
 * decision against CURRENT eligible evidence without re-deriving candidates.
 */
export function hashNameInput(spans: NameEvidenceText[]): string {
  return hashCanonicalJson({
    spans: spans.map(s => ({ channel: s.channel, span: s.span })),
    normalization: NAME_CANDIDATES_NORMALIZATION_VERSION,
  });
}

 // ─── NameDecision persistence ────────────────────────────────────────────────

export function toNameDecision(input: {
  result: NameSelectionResult;
  spans: NameEvidenceText[];
  /** Eligible brand for the mandatory-variant recheck (null = recheck skipped for brandless bundles). */
  brand?: string | null;
}): NameDecision | null {
  const { result, spans } = input;
  if (result.status !== 'resolved' || !result.title || !result.producer) return null;
  if (result.selectedEvidenceIds.length === 0 && result.producer !== 'manual') return null;
  // Singleton-stage recheck (issue #365): identical eligibility to the
  // builder — shipping-weight spans contribute no tokens, and a selected
  // candidate missing a mandatory evidenced net variant is rejected here —
  // selection can never persist an incomplete title. Manual corrections
  // carry operator authority and skip the recheck; brandless bundles skip
  // brand assembly exactly like the builder (missing_brand stays actionable
  // upstream).
  if (result.producer !== 'manual') {
    const netSpans = spans.filter(s => !/\bship\w*\s+wt\b|\bship\w*\s+weight\b|\bshipping\s+weight\b|\bgross\s+wt\b/i.test(s.span));
    const required = knownVariantTokens(netSpans.map(s => s.span));
    if (required.length > 0 && !required.every(q => variantTokenPresentInTitle(result.title as string, q))) return null;
    // Species-identity contradiction (issue #365 follow-up): structured OCR
    // species is authoritative identity, not naming material. When the
    // eligible bundle carries species evidence, every species word in the
    // resolved title must be evidenced. A single unsupported species word
    // refuses the title rather than letting a different supported word
    // launder a contradictory candidate.
    const evidencedSpecies = new Set(
      spans.filter(s => s.kind === 'species').map(s => s.span.trim().toLowerCase()).filter(Boolean),
    );
    if (evidencedSpecies.size > 0) {
      const titleLower = ` ${(result.title as string).toLowerCase()} `;
      const titleSpecies = new Set(
        SPECIES_IDENTITY_WORDS.filter(w => titleLower.includes(` ${w.toLowerCase()} `)),
      );
      if ([...titleSpecies].some(w => !evidencedSpecies.has(w.toLowerCase()))) {
        return null;
      }
    }
  }
  return {
    selectedTitle: result.title,
    selectedCandidateId: result.selectedCandidateId,
    candidates: result.candidates.map((c, i) => ({
      id: `name_${i + 1}`,
      title: c.title,
      components: c.components,
      evidenceIds: c.evidenceIds,
    })),
    overflow: result.overflow,
    selectedComponents: result.selectedEvidenceIds.length > 0 || result.selectedComponents.length > 0
      ? result.selectedComponents
      : [],
    selectedEvidenceIds: result.selectedEvidenceIds,
    normalizationVersion: NAME_CANDIDATES_NORMALIZATION_VERSION,
    inputHash: hashNameInput(spans),
    titleHash: sha256Hex(result.title),
    producer: result.producer,
    modelCallIds: result.modelCallIds,
    decidedAt: now(),
    selectionOutcome: result.selectionOutcome,
    reason: result.abstentionReason ?? null,
    fallbackLabeled: result.producer === 'deterministic' && result.modelCallIds.length === 0,
  };
}

// ─── Interpret ───────────────────────────────────────────────────────────────

function interpretNameChoiceAnswer(input: {
  choiceKey: string;
  selectedProbability: number;
  vendorConfidence: number;
  questionPlan: NameChoiceQuestionPlan;
  candidates: NameCandidateInput[];
  callId: string;
  evidenceIds: string[];
}): NameSelectionResult {
  const { choiceKey, selectedProbability, vendorConfidence, questionPlan, candidates, callId, evidenceIds } = input;
  if (choiceKey === NO_MATCH_CHOICE_KEY) {
    return {
      status: 'abstained', title: null, selectedCandidateId: null, candidates,
      overflow: false, producer: null, selectionOutcome: 'no_match',
      abstentionCode: 'no_match',
      abstentionReason: 'no_match: no supplied complete name correctly identifies this product.',
      modelCallIds: [callId], evidenceIds, selectedEvidenceIds: [], selectedComponents: [],
    };
  }
  if (choiceKey === INSUFFICIENT_EVIDENCE_CHOICE_KEY) {
    return {
      status: 'abstained', title: null, selectedCandidateId: null, candidates,
      overflow: false, producer: null, selectionOutcome: 'insufficient_evidence',
      abstentionCode: 'insufficient_evidence',
      abstentionReason: 'insufficient_evidence: eligible evidence cannot decide among the supplied names.',
      modelCallIds: [callId], evidenceIds, selectedEvidenceIds: [], selectedComponents: [],
    };
  }
  // Out-of-set IDs fail closed: an unknown key is never coerced to a title.
  const candidateId = choiceKeyToCanonicalId(questionPlan.keyToIdMap, choiceKey, 'option ID');
  const ordinal = Number(candidateId.replace(/^name_/, ''));
  const candidate = Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= candidates.length
    ? candidates[ordinal - 1]
    : null;
  if (!candidate) {
    return {
      status: 'failed', title: null, selectedCandidateId: null, candidates,
      overflow: false, producer: null, selectionOutcome: null,
      abstentionCode: 'service_failure',
      abstentionReason: `service_failure: model returned an out-of-set candidate id ("${choiceKey}").`,
      modelCallIds: [callId], evidenceIds, selectedEvidenceIds: [], selectedComponents: [],
    };
  }
  if (selectedProbability < NAME_SELECTION_MIN_PROBABILITY) {
    return {
      status: 'abstained', title: null, selectedCandidateId: candidateId, candidates,
      overflow: false, producer: null, selectionOutcome: null,
      abstentionCode: 'low_probability',
      abstentionReason: `low_probability: selected name "${candidate.title}" probability (${selectedProbability.toFixed(3)}) is below required threshold (${NAME_SELECTION_MIN_PROBABILITY}).`,
      modelCallIds: [callId], evidenceIds, selectedEvidenceIds: [], selectedComponents: [],
    };
  }
  void vendorConfidence;
  return {
    status: 'resolved', title: candidate.title, selectedCandidateId: candidateId,
    candidates, overflow: false, producer: 'typesafe', selectionOutcome: 'selected',
    modelCallIds: [callId], evidenceIds,
    selectedEvidenceIds: candidate.evidenceIds, selectedComponents: candidate.components,
  };
}

function failNameDispatch(input: {
  err: unknown;
  callId: string;
  startedAt: number;
  assertHeld?: () => void;
  candidates: NameCandidateInput[];
  evidenceIds: string[];
}): NameSelectionResult {
  const { err, callId, startedAt, assertHeld, candidates, evidenceIds } = input;
  if (err instanceof HeartbeatLostError) throw err;
  assertHeld?.();
  completeModelCall(callId, {
    status: MODEL_CALL_STATUS.failed,
    endedAt: now(),
    durationMs: Date.now() - startedAt,
    errorMessage: err instanceof Error ? err.message : String(err),
  });
  return {
    status: 'failed', title: null, selectedCandidateId: null, candidates,
    overflow: false, producer: null, selectionOutcome: null,
    abstentionCode: 'service_failure',
    abstentionReason: `service_failure: ${err instanceof Error ? err.message : String(err)}`,
    modelCallIds: [callId], evidenceIds, selectedEvidenceIds: [], selectedComponents: [],
    error: err,
  };
}

/**
 * Resolve one evidence-backed name: manual correction wins with truthful
 * provenance, then deterministic choice (zero calls), then bounded TypeSafe
 * Choice. Returns a terminal result; never invents text.
 */
export async function resolveNameSelection(
  params: NameSelectionParams,
): Promise<NameSelectionResult> {
  const { evidence, spans, brand, sku, runId, snapshot, modelPolicy, assertHeld } = params;
  assertHeld?.();
  const evidenceIds = evidence.map(e => e.id);

  // 0. Operator correction authority: a reviewer-corrected title resolves
  // as `manual` provenance — never presented as model output. The selected
  // components are the manual span ONLY (never all spans), and the record
  // carries an explicit manual-attestation marker since no model call or
  // per-span evidence id produced it.
  const manualTitle = params.manualTitle?.trim() || null;
  const manualSpan = spans.find(s => s.channel === 'manual' && s.span.trim() === manualTitle)
    ?? spans.find(s => s.channel === 'manual')
    ?? null;
  if (manualTitle) {
    return {
      status: 'resolved', title: manualTitle, selectedCandidateId: null, candidates: [],
      overflow: false, producer: 'manual', selectionOutcome: null,
      modelCallIds: [], evidenceIds,
      selectedEvidenceIds: manualSpan?.evidenceId ? [manualSpan.evidenceId] : ['manual:operator-attestation'],
      selectedComponents: manualSpan ? [manualSpan.span] : [manualTitle],
    };
  }

  // 1. Deterministic candidate construction from eligible evidence only.
  const built = buildNameCandidates({ spans, brand });
  if (built.kind === 'missing') {
    const code = built.reason.startsWith('missing_brand') ? 'missing_evidence' : 'missing_evidence';
    return {
      status: 'abstained', title: null, selectedCandidateId: null, candidates: [],
      overflow: false, producer: null, selectionOutcome: 'insufficient_evidence',
      abstentionCode: code, abstentionReason: built.reason,
      modelCallIds: [], evidenceIds, selectedEvidenceIds: [], selectedComponents: [],
    };
  }
  if (built.kind === 'conflict') {
    return {
      status: 'abstained', title: null, selectedCandidateId: null, candidates: [],
      overflow: false, producer: null, selectionOutcome: null,
      abstentionCode: 'conflict', abstentionReason: built.reason,
      modelCallIds: [], evidenceIds, selectedEvidenceIds: [], selectedComponents: [],
    };
  }
  if (built.kind === 'overflow') {
    return {
      status: 'abstained', title: null, selectedCandidateId: null, candidates: [],
      overflow: true, producer: null, selectionOutcome: null,
      abstentionCode: 'candidate_limit_exceeded',
      abstentionReason: built.reason,
      modelCallIds: [], evidenceIds, selectedEvidenceIds: [], selectedComponents: [],
    };
  }
  if (built.kind !== 'candidates') {
    return {
      status: 'abstained', title: null, selectedCandidateId: null, candidates: [],
      overflow: false, producer: null, selectionOutcome: null,
      abstentionCode: 'service_failure',
      abstentionReason: 'service_failure: unexpected name candidate outcome.',
      modelCallIds: [], evidenceIds, selectedEvidenceIds: [], selectedComponents: [],
    };
  }
  const candidates = built.candidates;

  // 2. Deterministic choice: single or stylistically-equivalent candidates
  // resolve with zero paid selection calls.
  const deterministic = deterministicNameChoice(candidates);
  if (deterministic) {
    const ordinal = candidates.indexOf(deterministic) + 1;
    return {
      status: 'resolved', title: deterministic.title,
      selectedCandidateId: `name_${ordinal}`, candidates, overflow: false,
      producer: 'deterministic', selectionOutcome: 'selected',
      modelCallIds: [], evidenceIds,
      selectedEvidenceIds: deterministic.evidenceIds, selectedComponents: deterministic.components,
    };
  }

  // 3. Typed Choice over at most 16 complete candidates. Ambiguous sets
  // beyond the bound already abstained visibly in the builder (kind
  // 'overflow') — candidates here are bounded, never a clipped prefix.

  // 4. Resolve route through frozen model policy.
  const effectivePolicy = asEffectivePolicyView(modelPolicy ?? snapshot?.modelPolicy ?? null);
  let route: ReturnType<typeof resolveModelRoute> | null = null;
  let conn: unknown = null;
  let isSystemOne = false;
  if (effectivePolicy) {
    try {
      const decision = resolveDecisionRouteForOperation(effectivePolicy, 'title_consolidation');
      route = decision.route;
      conn = decision.conn;
      isSystemOne = decision.isSystemOne;
    } catch (err) {
      if (err instanceof HeartbeatLostError) throw err;
      if (err instanceof ModelPolicyDeniedError) {
        assertHeld?.();
        insertPolicyDeniedTerminalCall({
          runId,
          stageName: 'name_consolidation',
          operation: 'title_consolidation',
          provider: err.provider ?? null,
          snapshotHash: snapshot?.snapshotHash ?? '',
          modelPolicyDigest: effectivePolicy.policyDigest,
          promptTemplateVersion: PROMPT_TEMPLATE_VERSIONS.title_consolidation,
          ruleVersion: RULE_VERSIONS.title_consolidation,
          errorMessage: err.message,
        });
        return {
          status: 'abstained', title: null, selectedCandidateId: null, candidates,
          overflow: false, producer: null, selectionOutcome: null,
          abstentionCode: 'policy_denied',
          abstentionReason: `Model policy denied: ${err.message}`,
          modelCallIds: [], evidenceIds, selectedEvidenceIds: [], selectedComponents: [],
        };
      }
      throw err;
    }
  }

  if (!isSystemOne || !route || !effectivePolicy) {
    // No chat-generation fallback chain: without a TypeSafe route the
    // deterministic candidates stand or the outcome stays actionable. A
    // single remaining candidate resolves deterministically; ambiguity
    // without typed selection abstains (safe fallback labeled downstream
    // only when it independently passes name/variant/title protections —
    // enforced by the stage, never here).
    return {
      status: 'abstained', title: null, selectedCandidateId: null, candidates,
      overflow: false, producer: null, selectionOutcome: 'insufficient_evidence',
      abstentionCode: 'service_failure',
      abstentionReason: 'service_failure: no TypeSafe route for name selection and candidates are semantically ambiguous — supply an operator manual title or enable the evaluated model.',
      modelCallIds: [], evidenceIds, selectedEvidenceIds: [], selectedComponents: [],
    };
  }

  // 5. TypeSafe Choice dispatch with audit rows and lease assertions.
  const jevConn = conn ?? {
    id: route.provider,
    label: 'TypeSafe Jev',
    transport: 'systemone',
    credential: route.apiKey,
    enabled: true,
  };
  // The shared assertion reads the persisted connection record; the inline
  // fallback above carries the same dispatch contract fields.
  assertConnectionEnabledForDispatch(jevConn as unknown as Parameters<typeof assertConnectionEnabledForDispatch>[0], route.model || TYPESAFE_EVALUATED_MODEL);
  const questionPlan = buildNameChoiceQuestion(candidates);
  const state = buildNameState(evidence, sku, brand, candidates, params.siblingTitles);
  const ctx = buildNameCallContext({ runId, snapshot });
  if (snapshot) assertModelPlanCompatible(snapshot, 'title_consolidation', ctx);
  const opened = openSingleChoiceRequest({
    route,
    state,
    questionPlan,
    runId,
    ctx,
    effectivePolicyDigest: effectivePolicy.policyDigest,
    assertHeld,
  });
  const interpreted = await runSingleChoiceDispatch({
    jevConn,
    request: opened.request,
    questionPlan,
    callId: opened.callId,
    assertHeld,
    startedAt: opened.startedAt,
    interpret: ({ choiceKey, selectedProbability, vendorConfidence }) =>
      interpretNameChoiceAnswer({
        choiceKey, selectedProbability, vendorConfidence,
        questionPlan, candidates, callId: opened.callId, evidenceIds,
      }),
    fail: (err) =>
      failNameDispatch({
        err, callId: opened.callId, startedAt: opened.startedAt,
        assertHeld, candidates, evidenceIds,
      }),
  });
  return interpreted;
}
