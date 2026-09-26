/**
 * System One Transport for TypeSafe typed judgments (Choice/Noul).
 *
 * This is the ONLY transport that speaks to `POST /v1/systemone`. It is
 * judgment-only by construction:
 * - Chat, naming, tool-calling, and vision workloads never reach it: there
 *   is no chat-messages/naming/tool/vision entry point here, and the
 *   capability gate (`assertSystemOneCapable`) plus server-side workload
 *   validation reject System One connections for those routes.
 * - `score` questions are rejected at the schema boundary (the shared
 *   `SystemOneQuestionSchema` accepts `choice`/`noul` only).
 *
 * Behavior:
 * - Direct HTTP through the existing network controls (`fetchWithDeadlines`:
 *   strict redirect denial, whole-request timeout). No SDK dependency and no
 *   duplicate retry stack.
 * - Bounded inputs: request body size, question count, and concurrency are
 *   capped before dispatch. Disablement is checked before dispatch AND before
 *   the single retry.
 * - Exactly one transient retry within the caller's total budget: 429/529 and
 *   network/timeout failures retry once with bounded backoff honoring
 *   `Retry-After`. Auth (401/403) and validation (400/404/422) never retry.
 * - Validated responses: shape via the shared Zod schemas, then exact
 *   response-question matching, canonical correlation (answer keys equal
 *   request keys — labels/aliases never substitute), choice membership,
 *   finite bounded probabilities, complete Choice distributions within a
 *   documented tolerance, selected-option consistency, and returned model
 *   identity (requested vs returned model both recorded; never silently
 *   substituted).
 *
 * Provenance: every dispatched attempt (primary + the single retry, success
 * or failure) is auditable through the standard `ai_model_calls` telemetry
 * when the caller opts in — no secrets or raw bodies are stored.
 */

import {
  SystemOneRequestSchema,
  SystemOneResponseSchema,
  type SystemOneRequest,
  type SystemOneResponse,
  type SystemOneAnswer,
} from '../shared/schemas/systemone';
import type { ProviderConnection } from './provider-connections';
import {
  assertSystemOneCapable,
  assertConnectionEnabledForDispatch,
  validateConnectionTrustZone,
} from './provider-connections';
import {
  AiAvailabilityError,
  AiMisconfigurationError,
  AiPolicyDeniedError,
  AiTransportError,
  fetchWithDeadlines,
} from './network-transport';

// ─── Public identity ─────────────────────────────────────────────────────────

export const TYPESAFE_PROVIDER_ID = 'typesafe';
export const TYPESAFE_DEFAULT_BASE_URL = 'https://api.typesafe.ai/v1';
export const TYPESAFE_APPROVED_HOST = 'api.typesafe.ai';
export const TYPESAFE_EVALUATED_MODEL = 'jev-1.13.0';
export const SYSTEMONE_ENDPOINT_PATH = '/systemone';
export const SYSTEMONE_MODELS_PATH = '/models';

/**
 * Canonical versioned pins this integration treats as known-good. Only the
 * evaluated pin (`jev-1.13.0`) is a known pin; `jev-latest`/`jev-preview`
 * are documented aliases (see `TYPESAFE_KNOWN_ALIASES`) recorded verbatim in
 * provenance when discovered — never known pins.
 */
export const TYPESAFE_KNOWN_MODELS: ReadonlyArray<string> = [
  TYPESAFE_EVALUATED_MODEL,
] as const;

/**
 * Documented TypeSafe aliases. These survive only as discovered models
 * (exact `/models` matches) — never as known pins.
 */
export const TYPESAFE_KNOWN_ALIASES: ReadonlyArray<string> = [
  'jev-latest',
  'jev-preview',
] as const;

/**
 * Maximum Choice options per question (two abstention options reserve two
 * slots, leaving 253 ordinary candidates). Over-limit sets are rejected with
 * an actionable candidate-limit error — never first-N clipped.
 */
export const SYSTEMONE_MAX_CHOICE_OPTIONS = 255;
export const SYSTEMONE_MAX_ABSTENTION_RESERVED = 2;

/** Application fan-out bound: questions per request. */
export const SYSTEMONE_MAX_QUESTIONS = 32;

/** Conservative application budget for the state payload (32k documented). */
export const SYSTEMONE_MAX_STATE_BYTES = 32_768;

/** Conservative application budget for the serialized request body (64k documented). */
export const SYSTEMONE_MAX_REQUEST_BYTES = 65_536;

/** Probability-distribution closure tolerance for Choice answers. */
export const SYSTEMONE_CHOICE_SUM_TOLERANCE = 0.01;

// ─── Error hierarchy (reuses the staged transport taxonomy) ──────────────────

/**
 * Thrown when a System One question or connection use is unsupported:
 * score questions, chat/naming/tool/vision routes against a System One
 * connection, or an unknown/unsupported pinned model. Never retries.
 */
export class SystemOneUnsupportedError extends AiTransportError {
  override readonly isMisconfiguration = true;

  constructor(message: string, connectionId?: string, modelId?: string, statusCode?: number) {
    super(message, connectionId, modelId, statusCode);
    this.name = 'SystemOneUnsupportedError';
  }
}

// ─── Capability + pin validation ─────────────────────────────────────────────

export interface SystemOnePinCheck {
  ok: boolean;
  /** Canonical reason code for UI/errors: `known_pin` | `approved_alias` | `unknown_pin`. */
  kind: 'known_pin' | 'approved_alias' | 'unknown_pin';
  message: string;
}

/**
 * Validate a pinned model WITHOUT substitution. Only the evaluated versioned
 * pin passes as `known_pin`; documented aliases pass as `approved_alias`
 * (resolvable only when discovery lists them — never as known pins). Anything
 * else is an actionable error — the caller must pick the known pin or a
 * listed alias, never receive a silent alias swap.
 */
export function checkSystemOneModelPin(modelId: string): SystemOnePinCheck {
  const pin = modelId?.trim() ?? '';
  if (TYPESAFE_KNOWN_MODELS.includes(pin)) {
    return {
      ok: true,
      kind: 'known_pin',
      message: `Model "${pin}" is a recognized TypeSafe model.`,
    };
  }
  if (TYPESAFE_KNOWN_ALIASES.includes(pin)) {
    return {
      ok: true,
      kind: 'approved_alias',
      message: `Model "${pin}" is a documented TypeSafe alias (resolves only when listed by discovery; never a versioned pin).`,
    };
  }
  return {
    ok: false,
    kind: 'unknown_pin',
    message:
      `Model "${pin || '(empty)'}" is not a recognized TypeSafe model. ` +
      `Choose the evaluated pin "${TYPESAFE_EVALUATED_MODEL}" or a documented alias (jev-latest, jev-preview). ` +
      `Pins are never silently substituted with an alias.`,
  };
}

/** Throwing variant of the pin check for dispatch-time validation. */
export function assertSystemOneModelPin(modelId: string, connectionId?: string): void {
  const check = checkSystemOneModelPin(modelId);
  if (!check.ok) {
    throw new SystemOneUnsupportedError(check.message, connectionId, modelId);
  }
}

/**
 * Sane pin semantics for alias resolution.
 *
 * The default/production pin is the evaluated versioned model
 * (`TYPESAFE_EVALUATED_MODEL`, currently `jev-1.13.0`). A configured
 * documented alias (`jev-latest`/`jev-preview`) resolves server-side to the
 * versioned pin, so `requested=alias, returned=evaluated-pin` is an expected
 * resolution — not a substitution. Anything else where
 * `returned !== requested` is a genuine mismatch and must stay rejected.
 */
export function isSystemOneModelMatch(requestedModel: string, returnedModel: string): boolean {
  if (!requestedModel || !returnedModel) return false;
  if (returnedModel === requestedModel) return true;
  if (
    TYPESAFE_KNOWN_ALIASES.includes(requestedModel) &&
    TYPESAFE_KNOWN_MODELS.includes(returnedModel)
  ) {
    return true;
  }
  return false;
}

/** Throwing variant of the alias-aware identity check for decision boundaries. */
export function assertSystemOneModelMatch(
  requestedModel: string,
  returnedModel: string,
  connectionId?: string,
): void {
  if (!isSystemOneModelMatch(requestedModel, returnedModel)) {
    throw new AiMisconfigurationError(
      `Model mismatch: requested model "${requestedModel}", but provider returned "${returnedModel}". Pinned model substitution is forbidden.`,
      connectionId,
      requestedModel,
    );
  }
}

// ─── Request validation ──────────────────────────────────────────────────────

export interface ValidatedSystemOneRequest extends SystemOneRequest {
  /** Exact request keys in insertion order (canonical correlation). */
  questionIds: string[];
  /** Serialized body bytes (bounded). */
  bodyBytes: number;
}

/**
 * Validate a System One request body against the shared schemas plus the
 * application bounds (question count, Choice option budget, state/body size).
 * Throws `SystemOneUnsupportedError` (unsupported shape/use) — never retries.
 */
export function validateSystemOneRequest(body: unknown): ValidatedSystemOneRequest {
  const parsed = SystemOneRequestSchema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`)
      .join('; ');
    throw new SystemOneUnsupportedError(
      `Invalid System One request: ${detail || 'request failed schema validation'}.`,
    );
  }
  const request = parsed.data;
  const questionIds = Object.keys(request.questions);
  if (questionIds.length === 0 || questionIds.length > SYSTEMONE_MAX_QUESTIONS) {
    throw new SystemOneUnsupportedError(
      `System One requests carry 1..${SYSTEMONE_MAX_QUESTIONS} questions; received ${questionIds.length}. ` +
        'Split fan-out across bounded requests instead of one oversized call.',
    );
  }
  // 32k state-plus-longest-question budget alongside the state.
  const serializedState = JSON.stringify(request.state);
  if (Buffer.byteLength(serializedState, 'utf8') > SYSTEMONE_MAX_STATE_BYTES) {
    throw new SystemOneUnsupportedError(
      `System One state payload exceeds the ${SYSTEMONE_MAX_STATE_BYTES}-byte application budget ` +
        `(${Buffer.byteLength(serializedState, 'utf8')} bytes). Reduce state before dispatch.`,
    );
  }

  for (const [questionId, question] of Object.entries(request.questions)) {
    if (question.type === 'choice') {
      const optionCount = Object.keys(question.criteria).length;
      if (optionCount > SYSTEMONE_MAX_CHOICE_OPTIONS) {
        throw new SystemOneUnsupportedError(
          `Question "${questionId}" declares ${optionCount} Choice options, above the documented ` +
            `${SYSTEMONE_MAX_CHOICE_OPTIONS}-option limit. This is a candidate-limit abstention: ` +
            'narrow the eligible set deterministically instead of clipping to first-N.',
        );
      }
    }
    const questionBytes = Buffer.byteLength(JSON.stringify(question), 'utf8');
    if (questionBytes > SYSTEMONE_MAX_STATE_BYTES) {
      throw new SystemOneUnsupportedError(
        `Question "${questionId}" exceeds the ${SYSTEMONE_MAX_STATE_BYTES}-byte per-question application budget.`,
      );
    }
  }

  const bodyBytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
  if (bodyBytes > SYSTEMONE_MAX_REQUEST_BYTES) {
    throw new SystemOneUnsupportedError(
      `System One request body is ${bodyBytes} bytes, above the ${SYSTEMONE_MAX_REQUEST_BYTES}-byte ` +
        'application budget (documented 64k request context). Reduce state or fan out across requests.',
    );
  }

  return { ...request, questionIds, bodyBytes };
}

// ─── Response validation ─────────────────────────────────────────────────────

export interface ValidatedSystemOneResponse {
  /** Requested model (verbatim pin/alias from the request). */
  requestedModel: string;
  /** Model that answered (verbatim from the response). */
  returnedModel: string;
  answers: Record<string, SystemOneAnswer>;
  usage: { inputTokens: number; outputTokens: number };
}

const isFiniteBoundedProbability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * Validate a System One response against the request that produced it:
 * - exact response-question matching (no missing or extra answers);
 * - type match per question (a `score` or mismatched answer kind rejects);
 * - Choice: selected-option membership, complete distribution over the
 *   request's criteria keys, finite bounded probabilities, closure to 1
 *   within tolerance, selected option is the argmax (ties: selected must be
 *   among the tied maxima);
 * - Noul: finite bounded P(yes);
 * - model/usage identity passthrough (requested + returned recorded; unknown
 *   returned pins never rewrite the request).
 */
export function validateSystemOneResponse(
  request: Pick<SystemOneRequest, 'model' | 'questions'>,
  responseBody: unknown,
  opts?: { connectionId?: string },
): ValidatedSystemOneResponse {
  const parsed = SystemOneResponseSchema.safeParse(responseBody);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || 'response'}: ${issue.message}`)
      .join('; ');
    throw new AiMisconfigurationError(
      `Invalid System One response shape: ${detail || 'response failed schema validation'}.`,
      opts?.connectionId,
      request.model,
    );
  }
  const response: SystemOneResponse = parsed.data;

  const requestIds = Object.keys(request.questions).sort();
  const responseIds = Object.keys(response.answers).sort();
  const missing = requestIds.filter((id) => !responseIds.includes(id));
  const extra = responseIds.filter((id) => !requestIds.includes(id));
  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing answers for: ${missing.join(', ')}`);
    if (extra.length > 0) parts.push(`unexpected answers for: ${extra.join(', ')}`);
    throw new AiMisconfigurationError(
      `System One response questions do not match the request (${parts.join('; ')}). ` +
        'Answers are correlated by exact question key — no substitution or omission is permitted.',
      opts?.connectionId,
      request.model,
    );
  }

  for (const [questionId, question] of Object.entries(request.questions)) {
    const answer = response.answers[questionId];
    if (!answer || answer.type !== question.type) {
      throw new SystemOneUnsupportedError(
        `Question "${questionId}" requested "${question.type}" but the answer is ` +
          `"${answer?.type ?? 'missing'}". Type mismatches and score answers are unsupported — rejected, never coerced.`,
        opts?.connectionId,
        request.model,
      );
    }
    if (question.type === 'choice' && answer.type === 'choice') {
      validateChoiceAnswer(questionId, Object.keys(question.criteria), answer, opts?.connectionId, request.model);
    }
    if (question.type === 'noul' && answer.type === 'noul') {
      if (!isFiniteBoundedProbability(answer.noul)) {
        throw new AiMisconfigurationError(
          `Question "${questionId}" returned a non-finite or out-of-range Noul probability ` +
            `(${String(answer.noul)}). Expected a finite number in [0, 1].`,
          opts?.connectionId,
          request.model,
        );
      }
    }
  }

  if (!response.model || typeof response.model !== 'string') {
    throw new AiMisconfigurationError(
      'System One response is missing model identity. Returned identity is required for provenance.',
      opts?.connectionId,
      request.model,
    );
  }

  return {
    requestedModel: request.model,
    returnedModel: response.model,
    answers: response.answers,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

function validateChoiceAnswer(
  questionId: string,
  criteriaKeys: string[],
  answer: Extract<SystemOneAnswer, { type: 'choice' }>,
  connectionId: string | undefined,
  modelId: string,
): void {
  const fail = (message: string): never => {
    throw new AiMisconfigurationError(message, connectionId, modelId);
  };

  if (!criteriaKeys.includes(answer.choice)) {
    fail(
      `Question "${questionId}" selected unknown option "${answer.choice}". ` +
        'The selected option must be a member of the requested criteria — labels never substitute for canonical keys.',
    );
  }

  const probabilityKeys = Object.keys(answer.probabilities).sort();
  const expectedKeys = [...criteriaKeys].sort();
  const missingOptions = expectedKeys.filter((key) => !probabilityKeys.includes(key));
  const extraOptions = probabilityKeys.filter((key) => !expectedKeys.includes(key));
  if (missingOptions.length > 0 || extraOptions.length > 0) {
    const parts: string[] = [];
    if (missingOptions.length > 0) parts.push(`missing probabilities for: ${missingOptions.join(', ')}`);
    if (extraOptions.length > 0) parts.push(`unexpected probabilities for: ${extraOptions.join(', ')}`);
    fail(
      `Question "${questionId}" returned an incomplete Choice distribution (${parts.join('; ')}). ` +
        'Every requested option must carry a probability.',
    );
  }

  let sum = 0;
  let maxValue = -Infinity;
  for (const probability of Object.values(answer.probabilities)) {
    if (!isFiniteBoundedProbability(probability)) {
      const offending = Object.entries(answer.probabilities).find(([, value]) => value === probability)?.[0] ?? '?';
      fail(
        `Question "${questionId}" returned a non-finite or out-of-range probability for option ` +
          `"${offending}" (${String(probability)}). Expected finite numbers in [0, 1].`,
      );
    }
    sum += probability;
    if (probability > maxValue) {
      maxValue = probability;
    }
  }
  if (Math.abs(sum - 1) > SYSTEMONE_CHOICE_SUM_TOLERANCE) {
    fail(
      `Question "${questionId}" Choice probabilities sum to ${sum.toFixed(4)}, outside the ` +
        `±${SYSTEMONE_CHOICE_SUM_TOLERANCE} tolerance around 1.`,
    );
  }
  const tiedMaxima = Object.entries(answer.probabilities)
    .filter(([, probability]) => probability === maxValue)
    .map(([option]) => option);
  if (!tiedMaxima.includes(answer.choice)) {
    fail(
      `Question "${questionId}" selected "${answer.choice}" but the highest-probability option is ` +
        `"${tiedMaxima.join('", "')}". The selected option must be the distribution argmax.`,
    );
  }
  if (!isFiniteBoundedProbability(answer.confidence)) {
    fail(
      `Question "${questionId}" returned a non-finite or out-of-range confidence ` +
        `(${String(answer.confidence)}). Expected a finite number in [0, 1].`,
    );
  }
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

export interface SystemOneDispatchOptions {
  /** Whole-request timeout per attempt (default: connection inference timeout). */
  timeoutMs?: number;
  /** Caller abort signal: cancellation propagates, never retries. */
  signal?: AbortSignal;
  /** Honor the Retry-After/overload backoff before the single retry. */
  retryAfterMs?: number;
}

export interface SystemOneDispatchResult extends ValidatedSystemOneResponse {
  attempts: number;
  retried: boolean;
}

const RETRYABLE_STATUS: Record<number, true> = { 408: true, 425: true, 429: true, 500: true, 502: true, 503: true, 529: true };
const NO_RETRY_STATUS: Record<number, true> = { 400: true, 401: true, 403: true, 404: true, 422: true };

/** Parse a bounded Retry-After delay (seconds or HTTP date). Null when absent/unparseable. */
export function parseRetryAfterMs(value: string | null, capMs = 10_000): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, capMs);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, Math.min(dateMs - Date.now(), capMs));
  }
  return null;
}

/** Bounded backoff for the single retry: Retry-After wins, else 500ms doubling capped at 5s. */
export function systemOneRetryDelayMs(retryAfterMs: number | null | undefined, attempt: number): number {
  if (retryAfterMs !== null && retryAfterMs !== undefined && Number.isFinite(retryAfterMs)) {
    return Math.max(0, Math.min(retryAfterMs, 10_000));
  }
  return Math.min(500 * 2 ** Math.max(0, attempt), 5000);
}

function systemOneSleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Dispatch a validated System One request against a TypeSafe connection.
 *
 * - Rejects non-System One transports and disabled connections before any
 *   network use (also re-checked before the retry).
 * - Sends `{ state, model, questions }` with Bearer auth through
 *   `fetchWithDeadlines` (redirect denial + timeout + caller cancellation).
 * - Retries at most once, only for transient failures (429/529/5xx/network/
 *   timeout) and only within budget. Auth/validation/unsupported failures and
 *   caller cancellation never retry.
 * - Returns validated answers plus requested/returned model identity and
 *   token usage for provenance. Raw bodies carry the credential-bearing
 *   request context and are never persisted here — callers record digests
 *   and identities only.
 */
export async function executeSystemOne(
  conn: ProviderConnection,
  modelId: string,
  questions: Record<string, { type: 'choice' | 'noul'; instructions: unknown; criteria?: unknown }>,
  state: unknown,
  options: SystemOneDispatchOptions = {},
): Promise<SystemOneDispatchResult> {
  // Validate trust zone first (fail closed): a misconfigured baseUrl must
  // never receive the bearer credential or product evidence. Mirrors the
  // chat path (network-transport executeOpenAiChat) and the health probe.
  try {
    validateConnectionTrustZone(conn);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AiPolicyDeniedError(
      `Trust zone policy violation for connection "${conn.id}": ${message}`,
      conn.id,
      modelId,
    );
  }
  assertSystemOneCapable(conn, modelId);
  assertConnectionEnabledForDispatch(conn, modelId);
  assertSystemOneModelPin(modelId, conn.id);

  const request = validateSystemOneRequest({ state, model: modelId, questions });
  const timeoutMs = options.timeoutMs ?? conn.inferenceTimeoutMs ?? 60_000;

  const cleanBase = conn.baseUrl.replace(/\/+$/, '');
  const url = `${cleanBase}${SYSTEMONE_ENDPOINT_PATH}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'BaystateCMS-AI/1.0',
  };
  if (conn.credential) {
    headers.Authorization = `Bearer ${conn.credential}`;
  }

  let attempt = 0;
  let retried = false;
  while (true) {
    attempt += 1;
    if (options.signal?.aborted) {
      throw new AiAvailabilityError(
        `System One request cancelled before attempt ${attempt} on "${conn.label}".`,
        conn.id,
        modelId,
      );
    }
    // Disablement is checked before dispatch AND before the retry: an
    // operator disabling the connection mid-flight halts further attempts.
    assertConnectionEnabledForDispatch(conn, modelId);

    let response: Response;
    try {
      response = await fetchWithDeadlines(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ state: request.state, model: request.model, questions: request.questions }),
        timeoutMs,
        signal: options.signal,
      });
    } catch (err: unknown) {
      if (err instanceof AiTransportError) {
        if (err instanceof AiPolicyDeniedError) throw err;
        if (attempt === 1 && (err instanceof AiAvailabilityError || (typeof err.statusCode === 'number' && RETRYABLE_STATUS[err.statusCode]))) {
          retried = true;
          await systemOneSleep(systemOneRetryDelayMs(options.retryAfterMs, 0));
          continue;
        }
        throw err;
      }
      if (err !== null && typeof err === 'object' && 'name' in err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw err;
      }
      const message = String(err instanceof Error ? err.message : err ?? '');
      const transient = message.includes('timed out') || message.includes('ECONNREFUSED') || message.includes('fetch failed') || message.includes('Connection refused') || message.includes('terminated');
      if (attempt === 1 && transient) {
        retried = true;
        await systemOneSleep(systemOneRetryDelayMs(options.retryAfterMs, 0));
        continue;
      }
      throw new AiAvailabilityError(
        `Network failure reaching System One on "${conn.label}" at ${url}: ${message.replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]').slice(0, 200)}`,
        conn.id,
        modelId,
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new AiMisconfigurationError(
        `Authentication failed for System One connection "${conn.label}" (HTTP ${response.status}). Check the TypeSafe API key.`,
        conn.id,
        modelId,
        response.status,
      );
    }
    if (response.status === 400 || response.status === 404 || response.status === 422) {
      const detail = await readErrorDetail(response);
      if (response.status === 400 || response.status === 422) {
        throw new SystemOneUnsupportedError(
          `System One rejected the request (HTTP ${response.status}): ${detail}`,
          conn.id,
          modelId,
          response.status,
        );
      }
      throw new AiMisconfigurationError(
        `System One request failed (HTTP ${response.status}): ${detail}`,
        conn.id,
        modelId,
        response.status,
      );
    }
    if (response.status === 429 || response.status === 529) {
      if (attempt === 1) {
        const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));
        retried = true;
        await systemOneSleep(systemOneRetryDelayMs(retryAfter ?? options.retryAfterMs, 0));
        continue;
      }
      throw new AiAvailabilityError(
        `System One rate limit/overload persisted after one retry (HTTP ${response.status}).`,
        conn.id,
        modelId,
        response.status,
      );
    }
    if (RETRYABLE_STATUS[response.status]) {
      if (attempt === 1) {
        retried = true;
        await systemOneSleep(systemOneRetryDelayMs(options.retryAfterMs, 0));
        continue;
      }
      throw new AiAvailabilityError(
        `System One transient failure persisted after one retry (HTTP ${response.status}).`,
        conn.id,
        modelId,
        response.status,
      );
    }
    if (NO_RETRY_STATUS[response.status] || (response.status >= 400 && response.status < 500)) {
      const detail = await readErrorDetail(response);
      throw new AiMisconfigurationError(
        `System One request failed (HTTP ${response.status}): ${detail}`,
        conn.id,
        modelId,
        response.status,
      );
    }
    if (!response.ok) {
      const detail = await readErrorDetail(response);
      throw new AiAvailabilityError(
        `HTTP ${response.status} from System One on "${conn.label}": ${detail}`,
        conn.id,
        modelId,
        response.status,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AiMisconfigurationError(
        'System One returned a non-JSON response body.',
        conn.id,
        modelId,
        response.status,
      );
    }
    const validated = validateSystemOneResponse(request, body, { connectionId: conn.id });
    return { ...validated, attempts: attempt, retried };
  }
}

/**
 * Structured dispatch helper taking a request envelope with { model, state, questions }.
 */
export async function dispatchSystemOne(
  conn: ProviderConnection,
  request: {
    model: string;
    state: unknown;
    questions: Record<string, { type: 'choice' | 'noul'; instructions: unknown; criteria?: unknown }>;
  },
  options: SystemOneDispatchOptions = {},
): Promise<SystemOneDispatchResult> {
  return executeSystemOne(conn, request.model, request.questions, request.state, options);
}


async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return String(text)
      .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
      .replace(/sk-[A-Za-z0-9_-]{4,}/g, 'sk-[REDACTED]')
      .slice(0, 200) || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

/** Connection capability predicates live in provider-connections (single owner). */
export { isSystemOneConnection } from './provider-connections';
