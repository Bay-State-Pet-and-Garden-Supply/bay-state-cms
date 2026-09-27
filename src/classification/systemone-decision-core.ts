/**
 * Shared SystemOne Decision Core (Issue #293 follow-up / Fallow gate).
 *
 * Single home for the dispatch / validation / state-building / question-planning
 * logic previously cloned across the three canonical decision boundaries:
 * - `attribute-decision.ts`
 * - `product-type-decision.ts`
 * - `page-decision.ts`
 *
 * Every helper here is intentionally small, pure (no DB / network I/O) and
 * unit-testable, with two documented exceptions that centralize shared I/O:
 * `resolveSystemOneCredential` and `resolveDecisionRouteForOperation`. Those two
 * move the byte-identical blocks out of the three decision files without
 * changing behavior: identical connection matching (including the
 * `typesafe` -> `typesafe-jev` / `systemone` transport alias acceptance),
 * identical default base URLs, identical frozen-policy assertions.
 *
 * Behavior-preservation contract (must not change):
 * - Identical question specs (option key order `opt_<i>` / `page_opt_<i>`,
 *   abstention keys, criteria text lives with the callers).
 * - Identical candidate sets and ordering (insertion order preserved;
 *   multi-value ordering is always P(yes) desc, then original index asc).
 * - Identical thresholds: 0.50 single-choice floor, 0.70 multi-value floor,
 *   0.40 uncertain floor.
 * - Identical abstention codes and audit / lease semantics (callers still own
 *   their model-call rows and `assertHeld` lease assertions).
 * - Identical model-match rule (alias acceptance via `isSystemOneModelMatch`;
 *   pinned-model substitution stays forbidden with the same message).
 * - Identical frozen execution / reuse hashes (callers still hash the same
 *   request payloads with `hashCanonicalJson`).
 */

import {
  SYSTEMONE_MAX_ABSTENTION_RESERVED,
  SYSTEMONE_MAX_CHOICE_OPTIONS,
  SYSTEMONE_MAX_STATE_BYTES,
  TYPESAFE_EVALUATED_MODEL,
  dispatchSystemOne,
  isSystemOneModelMatch,
} from '../ai/systemone-transport';
import { hashCanonicalJson } from '../shared/stable-id';
import { getFullAiRoutingConfig } from '../db/repositories/provider-connection-repo';
import { getApiKey } from '../db/repositories/api-key-repo';
import {
  assertModelPolicyIntact,
  resolveModelRoute,
  type ModelPolicyView,
  type ProtectedOperation,
} from './model-policy-gateway';
import { insertTerminalModelCall, completeModelCall, insertModelCallStart } from '../db/repositories/classification-model-call-repo';
import {
  COST_BASIS,
  MODEL_CALL_STATUS,
  type ModelCallContext,
} from './model-operation-registry';
import { HeartbeatLostError } from './heartbeat-errors';
import type { ProposalDerivation } from '../shared/schemas/classification';
import type { SystemOneAnswer } from '../shared/schemas/systemone';

export type SystemOneChoiceAnswer = Extract<SystemOneAnswer, { type: 'choice' }>;
export type SystemOneNoulAnswer = Extract<SystemOneAnswer, { type: 'noul' }>;

// ─── Shared thresholds & capacities ──────────────────────────────────────────

/** Single-choice selection floor shared by attribute / product-type / page (0.50). */
export const SYSTEMONE_SINGLE_CHOICE_MIN_PROBABILITY = 0.50;

/** Multi-value (Noul) selection floor shared by attribute / page (0.70). */
export const SYSTEMONE_MULTI_MIN_PROBABILITY = 0.70;

/** Floor below which every candidate probability means "no fitting option" (0.40). */
export const SYSTEMONE_MULTI_UNCERTAIN_FLOOR = 0.40;

/**
 * Maximum ordinary Choice candidates before an explicit limit abstention.
 * First-N clipping is forbidden, so callers must abstain instead (253).
 */
export const MAX_ORDINARY_CHOICE_CANDIDATES =
  SYSTEMONE_MAX_CHOICE_OPTIONS - SYSTEMONE_MAX_ABSTENTION_RESERVED;

/** Default base URLs used when a model-policy route needs a credential lookup. */
const DECISION_DEFAULT_BASE_URLS = {
  typesafe: 'https://api.typesafe.ai/v1',
  ollama: 'http://127.0.0.1:11434/v1',
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com',
} as const;

// ─── Credential resolution (shared I/O) ──────────────────────────────────────

interface ConnectionLike {
  id?: string;
  transport?: string;
  credential?: unknown;
  baseUrl?: unknown;
}

/**
 * Pure connection matcher behind credential resolution.
 * Accepts the `typesafe` alias (`typesafe-jev` id or `systemone` transport).
 * Generic over the connection record so callers keep their exact field types.
 */
export function findSystemOneConnection<T extends ConnectionLike>(
  connections: Record<string, T>,
  provider: string,
): T | null {
  const direct = connections[provider];
  if (direct) return direct;
  const aliased = Object.values(connections).find(
    c => c.id === provider || (provider === 'typesafe' && (c.id === 'typesafe-jev' || c.transport === 'systemone')),
  );
  return aliased ?? null;
}

/**
 * Resolve a dispatch credential for a provider.
 * Moved verbatim from the three decision boundaries: routing-config first,
 * `api_keys` fallback second, `null` when unconfigured.
 */
export function resolveSystemOneCredential(provider: string) {
  try {
    const aiConfig = getFullAiRoutingConfig();
    const conn = findSystemOneConnection(aiConfig.connections, provider);
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

// ─── Frozen route resolution (shared I/O) ────────────────────────────────────

export interface DecisionRoute {
  route: ReturnType<typeof resolveModelRoute>;
  conn: unknown;
  isSystemOne: boolean;
}

/** A route is SystemOne when the provider is `typesafe` or the transport matches. */
function isSystemOneProviderRoute(provider: string, transport?: string | null): boolean {
  return provider === 'typesafe' || transport === 'systemone';
}

/**
 * Coerce a raw policy value to an effective frozen policy view (null when
 * absent or malformed). Shared by every decision boundary's frozen-route
 * preamble so the shape check lives in exactly one place.
 */
export function asEffectivePolicyView(rawPolicy: unknown): ModelPolicyView | null {
  return rawPolicy && typeof rawPolicy === 'object' && 'policyDigest' in rawPolicy && 'providerLocalities' in rawPolicy
    ? (rawPolicy as ModelPolicyView)
    : null;
}

/**
 * Resolve the frozen model-policy route for a protected operation.
 * This is the shared try-body previously cloned per decision file; callers
 * keep their own catch blocks (policy-denied audit rows differ per stage).
 */
export function resolveDecisionRouteForOperation(
  effectivePolicy: ModelPolicyView,
  operation: ProtectedOperation,
): DecisionRoute {
  assertModelPolicyIntact(effectivePolicy);
  const resolvedRoute = resolveModelRoute(effectivePolicy, operation, {
    getCredential: (p: string) => resolveSystemOneCredential(p),
    defaultBaseUrls: { ...DECISION_DEFAULT_BASE_URLS },
  });
  const aiConfig = getFullAiRoutingConfig();
  const conn = findSystemOneConnection(aiConfig.connections, resolvedRoute.provider);
  const transport = (conn as { transport?: string } | null)?.transport;
  return {
    route: resolvedRoute,
    conn,
    isSystemOne: isSystemOneProviderRoute(resolvedRoute.provider, transport),
  };
}

// ─── Choice question planning (pure) ─────────────────────────────────────────

export interface ChoiceKeyMaps {
  keyToIdMap: Map<string, string>;
  idToKeyMap: Map<string, string>;
}

export interface ChoiceOptionLike {
  value: string;
  label: string;
  description?: string;
}

export interface PageCandidateLike {
  pageId: string;
  pageName: string;
  path: string;
}

/**
 * Build request-local option key maps plus per-option criteria entries.
 * Preserves insertion order; keys are `${keyPrefix}_${index}`.
 */
export function buildChoiceKeyMaps(
  criteria: Record<string, string>,
  items: ChoiceOptionLike[],
  keyPrefix: string,
): ChoiceKeyMaps {
  const keyToIdMap = new Map<string, string>();
  const idToKeyMap = new Map<string, string>();
  for (let i = 0; i < items.length; i++) {
    const opt = items[i];
    const key = `${keyPrefix}_${i}`;
    keyToIdMap.set(key, opt.value);
    idToKeyMap.set(opt.value, key);
    const desc = opt.description ? `: ${opt.description}` : '';
    criteria[key] = `${opt.label}${desc}`;
  }
  return { keyToIdMap, idToKeyMap };
}

/** Page-flavored variant: keys map to canonical page IDs with path-qualified labels. */
export function buildPageChoiceKeyMaps(
  criteria: Record<string, string>,
  candidates: PageCandidateLike[],
  keyPrefix = 'page_opt',
): ChoiceKeyMaps {
  const keyToIdMap = new Map<string, string>();
  const idToKeyMap = new Map<string, string>();
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const key = `${keyPrefix}_${i}`;
    keyToIdMap.set(key, cand.pageId);
    idToKeyMap.set(cand.pageId, key);
    criteria[key] = `${cand.pageName} (Path: "${cand.path}")`;
  }
  return { keyToIdMap, idToKeyMap };
}

/** Sanitize one id segment for Noul question ids (shared regex). */
export function sanitizeQuestionIdSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '_');
}

// ─── Bounded state building (pure) ───────────────────────────────────────────

/** Coerce one evidence record to its displayable text value. */
export function evidenceTextValue(e: { value?: unknown; snippet?: string | null }): string {
  return typeof e.value === 'string' ? e.value : (e.snippet ?? '');
}

/** Lower-cased source field for name / brand / description matching. */
export function sourceFieldOf(e: { sourceField?: string | null }): string {
  return (e.sourceField ?? '').toLowerCase();
}

/** Trim a list of snippet strings to at most `maxItems` of `maxChars` each. */
export function truncateSnippets(snippets: string[], maxItems = 15, maxChars = 500): string[] {
  return snippets.slice(0, maxItems).map(s => s.slice(0, maxChars));
}

/** True when the serialized state exceeds the SystemOne state budget. */
function isStateOverBudget(state: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(state), 'utf-8') > SYSTEMONE_MAX_STATE_BYTES;
}

/**
 * Apply a caller-provided shrink step when the state exceeds budget.
 * Each decision boundary keeps its own shrink policy; this only owns the check.
 */
export function fitStateToBudget<T>(state: T, shrink: (s: T) => void): T {
  if (isStateOverBudget(state)) shrink(state);
  return state;
}

// ─── Multi-value (Noul) policy primitives (pure) ─────────────────────────────

export interface ProbabilityCandidate {
  optionLabel: string;
  optionIndex: number;
  prob: number;
}

/** Map each candidate label to its P(yes) probability (insertion order kept). */
export function buildCandidateProbabilities(
  candidates: ProbabilityCandidate[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of candidates) out[c.optionLabel] = c.prob;
  return out;
}

/** Highest candidate probability, or 0 when there are no candidates. */
export function maxCandidateProbability<T extends { prob: number }>(candidates: T[]): number {
  return Math.max(...candidates.map(c => c.prob), 0);
}

/**
 * Deterministic multi-value ordering: P(yes) desc, then original index asc.
 * The index accessor covers both flavors (`optionIndex` for attributes,
 * `candidateIndex` for pages). Returns a new sorted array; inputs untouched.
 */
export function sortCandidatesByProbability<T extends { prob: number }>(
  candidates: T[],
  indexOf: (c: T) => number,
): T[] {
  return [...candidates].sort((a, b) => b.prob - a.prob || indexOf(a) - indexOf(b));
}

/**
 * Detect an unresolvable tie exactly at the cardinality boundary.
 * Returns the tied probability, or null when truncation is unambiguous.
 */
export function checkCardinalityTieAtBoundary<T extends { prob: number }>(
  sortedQualifying: T[],
  maxItems: number,
): number | null {
  if (typeof maxItems !== 'number' || maxItems <= 0) return null;
  if (sortedQualifying.length <= maxItems) return null;
  const k = maxItems;
  if (sortedQualifying[k - 1].prob === sortedQualifying[k].prob) {
    return sortedQualifying[k].prob;
  }
  return null;
}

/**
 * Truncate qualifying candidates to the cardinality limit (post tie-check).
 * Returns a new array; inputs are never mutated.
 */
export function applyCardinalityLimit<T>(sortedQualifying: T[], maxItems: number): T[] {
  if (typeof maxItems !== 'number' || maxItems <= 0) return sortedQualifying;
  if (sortedQualifying.length <= maxItems) return sortedQualifying;
  return sortedQualifying.slice(0, maxItems);
}

// ─── Dispatch validation (pure) ──────────────────────────────────────────────

/**
 * Enforce the pinned-model rule with the canonical message.
 * Alias acceptance itself lives in `isSystemOneModelMatch`; any mismatch is a
 * hard failure because pinned-model substitution is forbidden.
 */
export function assertSystemOneModelMatch(requestModel: string, returnedModel: string): void {
  if (!isSystemOneModelMatch(requestModel, returnedModel)) {
    throw new Error(
      `Model mismatch: requested model "${requestModel}", but provider returned "${returnedModel}". Pinned model substitution is forbidden.`,
    );
  }
}

/**
 * Require a Choice answer for a question id, preserving the canonical message.
 * Returns the narrowed answer for the caller to interpret.
 */
export function requireChoiceAnswer(
  answers: Record<string, SystemOneAnswer>,
  questionId: string,
): SystemOneChoiceAnswer {
  const answer = answers[questionId];
  if (!answer || answer.type !== 'choice') {
    throw new Error(`Expected choice answer for question "${questionId}", got "${answer?.type ?? 'missing'}".`);
  }
  return answer;
}

/** Require a Noul answer for a question id, preserving the canonical message. */
export function requireNoulAnswer(
  answers: Record<string, SystemOneAnswer>,
  questionId: string,
): SystemOneNoulAnswer {
  const answer = answers[questionId];
  if (!answer || answer.type !== 'noul') {
    throw new Error(`Expected noul answer for question "${questionId}", got "${answer?.type ?? 'missing'}".`);
  }
  return answer;
}

/**
 * Map a returned Choice key to its canonical id, preserving the canonical
 * message (callers choose the trailing noun to keep their exact wording:
 * `option value` for attributes, `option ID` for product types).
 */
export function choiceKeyToCanonicalId(
  keyToIdMap: Map<string, string>,
  choiceKey: string,
  noun: 'option value' | 'option ID',
): string {
  const canonicalId = keyToIdMap.get(choiceKey);
  if (!canonicalId) {
    throw new Error(`Returned choice key "${choiceKey}" does not map to any canonical ${noun}.`);
  }
  return canonicalId;
}

// ─── Shared audit helpers ────────────────────────────────────────────────────

export interface PolicyDeniedTerminalCall {
  runId: string;
  stageName: string;
  operation: string;
  provider: string | null;
  snapshotHash: string;
  modelPolicyDigest: string;
  promptTemplateVersion: string;
  ruleVersion: string;
  errorMessage: string;
}

/**
 * Record the terminal `policy_denied` audit row shared by every decision
 * boundary's frozen-route catch block. Stage / operation / template versions
 * stay caller-supplied so each boundary keeps its exact audit identity.
 */
export function insertPolicyDeniedTerminalCall(input: PolicyDeniedTerminalCall): void {
  insertTerminalModelCall({
    runId: input.runId,
    stageName: input.stageName,
    operation: input.operation,
    attempt: 1,
    provider: input.provider,
    model: null,
    locality: null,
    snapshotHash: input.snapshotHash,
    modelPolicyDigest: input.modelPolicyDigest,
    promptTemplateVersion: input.promptTemplateVersion,
    ruleVersion: input.ruleVersion,
    systemPromptHash: '',
    userPromptHash: '',
    status: MODEL_CALL_STATUS.policyDenied,
    errorMessage: input.errorMessage,
    costBasis: COST_BASIS.unknown,
  });
}

export interface DecisionModelCallContext {
  stage: ModelCallContext['stage'];
  operation: ModelCallContext['operation'];
  attempt: number;
  snapshotHash: string;
  promptTemplateVersion: string;
  ruleVersion: string;
}

export interface DecisionModelCallRoute {
  provider: string;
  model: string;
  locality: string;
}

/**
 * Open one decision model call: the durable audit start row shared by every
 * Jev dispatch site. Stage / operation / versions flow through the caller's
 * audit context; the request hash is computed by the caller.
 */
export function openDecisionModelCall(input: {
  runId: string;
  ctx: DecisionModelCallContext;
  route: DecisionModelCallRoute | null;
  effectivePolicyDigest: string;
  promptHash: string;
}): string {
  const { runId, ctx, route, effectivePolicyDigest, promptHash } = input;
  return insertModelCallStart({
    runId,
    stageName: ctx.stage,
    operation: ctx.operation,
    attempt: ctx.attempt,
    provider: route!.provider,
    model: route!.model,
    requestedModel: route!.model,
    locality: route!.locality,
    snapshotHash: ctx.snapshotHash,
    modelPolicyDigest: effectivePolicyDigest,
    promptTemplateVersion: ctx.promptTemplateVersion,
    ruleVersion: ctx.ruleVersion,
    systemPromptHash: promptHash,
    userPromptHash: promptHash,
  });
}

export interface SingleChoiceQuestionLike {
  questionId: string;
  instructions: string;
  criteria: Record<string, string>;
}

export interface SingleChoiceRequestPreparation<TState = unknown> {
  request: {
    model: string;
    state: TState;
    questions: Record<string, { type: 'choice'; instructions: string; criteria: Record<string, string> }>;
  };
  promptHash: string;
  callId: string;
  startedAt: number;
}

/**
 * Open one single-choice request: envelope assembly, hashing, the durable
 * audit start row, and the dispatch clock. Question planning and bounded
 * state stay with the callers (specs differ per boundary).
 */
export function openSingleChoiceRequest<TState>(input: {
  route: DecisionModelCallRoute;
  state: TState;
  questionPlan: SingleChoiceQuestionLike;
  runId: string;
  ctx: DecisionModelCallContext;
  effectivePolicyDigest: string;
  assertHeld?: () => void;
}): SingleChoiceRequestPreparation<TState> {
  const { route, state, questionPlan, runId, ctx, effectivePolicyDigest, assertHeld } = input;
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

  const promptHash = hashCanonicalJson(request);

  const callId = openDecisionModelCall({
    runId,
    ctx,
    route,
    effectivePolicyDigest,
    promptHash,
  });

  const startedAt = Date.now();

  return { request, promptHash, callId, startedAt };
}

// ─── Shared single-choice dispatch execution ───────────────────────────────

export interface ChoicePlanLike {
  questionId: string;
  keyToIdMap: Map<string, string>;
}

export interface SingleChoiceDispatchAnswer {
  choiceKey: string;
  selectedProbability: number;
  vendorConfidence: number;
}

export interface SingleChoiceDispatchRequest {
  model: string;
  state: unknown;
  questions: Record<string, { type: 'choice' | 'noul'; instructions: unknown; criteria?: unknown }>;
}

/**
 * Execute one prepared single-choice SystemOne dispatch with the shared
 * audit-complete row, pinned-model check, and Choice answer extraction.
 * Interpretation and failure mapping stay with the callers (result types
 * differ per boundary); lease loss rethrows with no post-loss writes.
 */
export async function runSingleChoiceDispatch<TPlan extends ChoicePlanLike, TResult>(input: {
  jevConn: unknown;
  request: SingleChoiceDispatchRequest;
  questionPlan: TPlan;
  callId: string;
  assertHeld?: () => void;
  startedAt: number;
  interpret: (answer: SingleChoiceDispatchAnswer) => TResult | Promise<TResult>;
  fail: (err: unknown) => TResult | Promise<TResult>;
}): Promise<TResult> {
  const { jevConn, request, questionPlan, callId, assertHeld, startedAt, interpret, fail } = input;
  try {
    assertHeld?.();
    const result = await dispatchSystemOne(jevConn as any, request);
    assertHeld?.();

    assertSystemOneModelMatch(request.model, result.returnedModel);

    const durationMs = Date.now() - startedAt;
    const answer = requireChoiceAnswer(result.answers, questionPlan.questionId);

    const choiceKey = answer.choice;
    const selectedProbability = answer.probabilities[choiceKey] ?? 0;
    const vendorConfidence = answer.confidence;

    completeModelCall(callId, {
      status: MODEL_CALL_STATUS.success,
      endedAt: new Date().toISOString(),
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

    return interpret({ choiceKey, selectedProbability, vendorConfidence });
  } catch (err) {
    if (err instanceof HeartbeatLostError) throw err;
    return fail(err);
  }
}

// ─── Judgment derivation builders (pure) ─────────────────────────────────────

/**
 * Build the shared `systemone_judgment` Noul derivation payload.
 * The vendor confidence is always null for Noul judgments; candidate
 * probabilities and the abstention code are attached only when present,
 * exactly like the inline literals this replaces.
 */
export function buildNoulJudgmentDerivation(
  questionId: string,
  selectedProbability: number | null,
  opts?: { abstentionCode?: string; candidateProbabilities?: Record<string, number> },
): ProposalDerivation {
  return {
    kind: 'systemone_judgment',
    primitive: 'noul',
    questionId,
    selectedProbability,
    vendorConfidence: null,
    probabilityBasis: 'noul_probability',
    ...(opts?.abstentionCode ? { abstentionCode: opts.abstentionCode } : {}),
    ...(opts?.candidateProbabilities ? { candidateProbabilities: opts.candidateProbabilities } : {}),
  } as ProposalDerivation;
}

/**
 * Build the shared `systemone_judgment` Choice derivation payload.
 * The abstention code is attached only when present, exactly like the
 * inline literals this replaces.
 */
export function buildChoiceJudgmentDerivation(
  questionId: string,
  selectedProbability: number | null,
  vendorConfidence: number | null,
  abstentionCode?: string,
): ProposalDerivation {
  return {
    kind: 'systemone_judgment',
    primitive: 'choice',
    questionId,
    selectedProbability,
    vendorConfidence,
    probabilityBasis: 'choice_probability',
    ...(abstentionCode ? { abstentionCode } : {}),
  } as ProposalDerivation;
}
