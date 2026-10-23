/**
 * Resilient Network Transport for AI Inference.
 *
 * Implements strict redirect blocking (anti-SSRF), error categorization
 * (Availability vs Misconfiguration vs Policy Denial), whole-request timeouts, and OpenAI-compatible dispatch.
 */

import type { ProviderConnection } from './provider-connections';
import { validateConnectionTrustZone } from './provider-connections';
import {
  getItemAcquisitionBudgetSignal,
  getItemAcquisitionModelOutputLimit,
  reserveItemAcquisitionModelAttempt,
} from '../onboarding/item-acquisition-budget';


const responseByteCounters = new WeakMap<Response, { value: number }>();

/** Wrap an HTTP response stream with an enforced byte ceiling without buffering it in advance. */
export function limitFetchResponseBytes(response: Response, maximumBytes: number): Response {
  const counter = { value: 0 };
  if (!response.body) {
    responseByteCounters.set(response, counter);
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        counter.value += next.value.byteLength;
        if (counter.value > maximumBytes) {
          void reader.cancel().catch(() => undefined);
          controller.error(new Error('model_response_budget_exceeded'));
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  const bounded = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  responseByteCounters.set(bounded, counter);
  return bounded;
}

export function fetchResponseBytes(response: Response): number | undefined {
  return responseByteCounters.get(response)?.value;
}
// ─── Error Hierarchy ──────────────────────────────────────────────────────────

export abstract class AiTransportError extends Error {
  readonly isAvailabilityFailure: boolean = false;
  readonly isMisconfiguration: boolean = false;
  readonly isPolicyDenial: boolean = false;
  readonly connectionId?: string;
  readonly modelId?: string;
  readonly statusCode?: number;

  constructor(message: string, connectionId?: string, modelId?: string, statusCode?: number) {
    super(message);
    this.name = 'AiTransportError';
    this.connectionId = connectionId;
    this.modelId = modelId;
    this.statusCode = statusCode;
  }
}

/**
 * Thrown when a remote machine is unreachable (connection refused, timeout, 502/503).
 * Triggers clean, immediate failover to configured fallbacks.
 */
export class AiAvailabilityError extends AiTransportError {
  override readonly isAvailabilityFailure = true;

  constructor(message: string, connectionId?: string, modelId?: string, statusCode?: number) {
    super(message, connectionId, modelId, statusCode);
    this.name = 'AiAvailabilityError';
  }
}

/**
 * Thrown when a host is reachable, but the requested model is missing (HTTP 404) or credentials fail.
 * Allows fallback, but marks the route as Misconfigured with a visible warning.
 */
export class AiMisconfigurationError extends AiTransportError {
  override readonly isMisconfiguration = true;

  constructor(message: string, connectionId?: string, modelId?: string, statusCode?: number) {
    super(message, connectionId, modelId, statusCode);
    this.name = 'AiMisconfigurationError';
  }
}

/**
 * Thrown when a request violates Trust Zone, redirect rules, or data-sharing governance.
 * FAILS CLOSED immediately. Never falls back.
 */
export class AiPolicyDeniedError extends AiTransportError {
  override readonly isPolicyDenial = true;

  constructor(message: string, connectionId?: string, modelId?: string) {
    super(message, connectionId, modelId);
    this.name = 'AiPolicyDeniedError';
  }
}

// ─── Network Transport ────────────────────────────────────────────────────────

export interface FetchWithDeadlinesOptions extends RequestInit {
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/**
 * Executes a fetch request with strict redirect blocking (anti-SSRF) and whole-request timeout.
 */
export async function fetchWithDeadlines(
  url: string,
  options: FetchWithDeadlinesOptions = {},
): Promise<Response> {
  const {
    timeoutMs = 60000,
    maxResponseBytes,
    signal: callerSignal,
    ...fetchInit
  } = options;

  const controller = new AbortController();

  if (callerSignal) {
    callerSignal.addEventListener('abort', () => controller.abort(callerSignal.reason));
  }

  const timer = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      ...fetchInit,
      redirect: 'manual', // Strictly reject HTTP redirects to prevent trust-zone / SSRF bypass
      signal: controller.signal,
    });

    // Check for HTTP 3xx Redirects
    if (response.status >= 300 && response.status < 400) {
      throw new AiPolicyDeniedError(
        `HTTP ${response.status} redirect from ${url} rejected: AI endpoints forbid redirects to protect data-sharing boundaries.`,
      );
    }

    return maxResponseBytes === undefined ? response : limitFetchResponseBytes(response, maxResponseBytes);
  } catch (err: any) {
    const msg = String(err?.message || '');
    const isTimeout = msg.includes('timed out') || err?.name === 'AbortError' || err?.name === 'TimeoutError';
    const isConnRefused = msg.includes('ECONNREFUSED') || msg.includes('fetch failed') || msg.includes('Connection refused');

    if (isTimeout || isConnRefused) {
      throw new AiAvailabilityError(
        `Host unreachable at ${url}: ${isTimeout ? `Timed out (${timeoutMs}ms)` : 'Connection refused'}`,
      );
    }

    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── OpenAI-Compatible Chat Dispatch ──────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: 'text' | 'image_url'; text?: string; image_url?: { url: string } }>;
}

export interface ChatCompletionOptions {
  temperature?: number;
  /** OpenAI-compatible frequency_penalty (e.g. packaging-OCR repetition retry). */
  frequencyPenalty?: number;
  maxTokens?: number;
  responseFormat?: { type: 'text' | 'json_object' | 'json_schema'; json_schema?: any };
  tools?: any[];
  reasoningEffort?: string;
  signal?: AbortSignal;
}

/**
 * Dispatches an OpenAI-compatible /chat/completions call against a ProviderConnection.
 */
export async function executeOpenAiChat(
  conn: ProviderConnection,
  modelId: string,
  messages: ChatMessage[],
  options: ChatCompletionOptions = {},
): Promise<{
  content: string;
  toolCalls?: any[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}> {
  // 1. Validate Trust Zone first (fail closed)
  try {
    validateConnectionTrustZone(conn);
  } catch (err: any) {
    throw new AiPolicyDeniedError(
      `Trust zone policy violation for connection "${conn.id}": ${err.message}`,
      conn.id,
      modelId,
    );
  }

  const cleanBase = conn.baseUrl.replace(/\/+$/, '');
  const url = `${cleanBase}/chat/completions`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'BaystateCMS-AI/1.0',
  };
  if (conn.credential) {
    headers.Authorization = `Bearer ${conn.credential}`;
  }

  const bodyPayload: Record<string, unknown> = {
    model: modelId,
    messages,
    stream: false,
  };

  if (options.temperature !== undefined) bodyPayload.temperature = options.temperature;
  if (options.frequencyPenalty !== undefined) bodyPayload.frequency_penalty = options.frequencyPenalty;
  if (options.maxTokens !== undefined) bodyPayload.max_tokens = options.maxTokens;
  if (options.reasoningEffort !== undefined) bodyPayload.reasoning_effort = options.reasoningEffort;
  if (options.responseFormat) bodyPayload.response_format = options.responseFormat;
  if (options.tools && options.tools.length > 0) bodyPayload.tools = options.tools;
  const outputTokenLimit = getItemAcquisitionModelOutputLimit(conn.id, modelId);
  if (outputTokenLimit !== null) bodyPayload.max_tokens = Math.min(options.maxTokens ?? outputTokenLimit, outputTokenLimit);
  const serializedBody = JSON.stringify(bodyPayload);
  const timeoutMs = conn.inferenceTimeoutMs ?? 60000;
  const itemAttempt = reserveItemAcquisitionModelAttempt({
    provider: conn.id,
    model: modelId,
    requestBytes: Buffer.byteLength(serializedBody, 'utf8'),
    requestedOutputTokens: typeof bodyPayload.max_tokens === 'number' ? bodyPayload.max_tokens : 0,
    timeoutMs,
  });
  const attemptStartedAt = Date.now();

  try {
    let response: Response;
    try {
      itemAttempt?.markDispatched();
      response = await fetchWithDeadlines(url, {
        method: 'POST',
        headers,
        body: serializedBody,
        timeoutMs,
        signal: getItemAcquisitionBudgetSignal(options.signal),
        ...(itemAttempt ? { maxResponseBytes: itemAttempt.maxResponseBytes } : {}),
      });
    } catch (err: any) {
      if (err instanceof AiTransportError) {
        throw new (err.constructor as any)(err.message, conn.id, modelId, err.statusCode);
      }
      throw new AiAvailabilityError(
        `Network failure connecting to "${conn.label}" at ${url}: ${err.message}`,
        conn.id,
        modelId,
      );
    }

    if (response.status === 404) {
      const errText = await response.text().catch(() => '');
      throw new AiMisconfigurationError(
        `Model "${modelId}" not found on "${conn.label}" (HTTP 404). Host is online but model is missing/unloaded: ${errText.slice(0, 150)}`,
        conn.id,
        modelId,
        404,
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new AiMisconfigurationError(
        `Authentication failed for "${conn.label}" (HTTP ${response.status}). Check API key/credential.`,
        conn.id,
        modelId,
        response.status,
      );
    }

    if (response.status >= 500) {
      const errText = await response.text().catch(() => '');
      throw new AiAvailabilityError(
        `Server error from "${conn.label}" (HTTP ${response.status}): ${errText.slice(0, 150)}`,
        conn.id,
        modelId,
        response.status,
      );
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new AiAvailabilityError(
        `HTTP ${response.status} from "${conn.label}": ${errText.slice(0, 150)}`,
        conn.id,
        modelId,
        response.status,
      );
    }

    const parsed: unknown = await response.json();
    const data = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const firstChoice = choices[0] && typeof choices[0] === 'object' ? choices[0] as Record<string, unknown> : {};
    const message = firstChoice.message && typeof firstChoice.message === 'object' ? firstChoice.message as Record<string, unknown> : {};
    const content = typeof message.content === 'string' ? message.content : '';
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : undefined;
    const usage = data.usage && typeof data.usage === 'object' ? data.usage as Record<string, unknown> : null;
    const promptTokens = typeof usage?.prompt_tokens === 'number' && Number.isSafeInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0 ? usage.prompt_tokens : undefined;
    const completionTokens = typeof usage?.completion_tokens === 'number' && Number.isSafeInteger(usage.completion_tokens) && usage.completion_tokens >= 0 ? usage.completion_tokens : undefined;
    const totalTokens = typeof usage?.total_tokens === 'number' && Number.isSafeInteger(usage.total_tokens) && usage.total_tokens >= 0 ? usage.total_tokens : undefined;
    itemAttempt?.settle({
      responseBytes: fetchResponseBytes(response) ?? itemAttempt.maxResponseBytes,
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      durationMs: Date.now() - attemptStartedAt,
    });

    return {
      content,
      toolCalls,
      usage: usage
        ? {
            promptTokens: promptTokens ?? 0,
            completionTokens: completionTokens ?? 0,
            totalTokens: totalTokens ?? 0,
          }
        : undefined,
    };
  } catch (error) {
    try { itemAttempt?.settleUnknown(); } catch { /* scope finalization retains any unresolved dispatch */ }
    throw error;
  }
}
