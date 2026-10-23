import { getApiKey } from '../db/repositories/api-key-repo';
import { PaidEffectBudgetError, runPaidEffect } from '../ai/paid-effect-budget';
import type { PaidEffectAttemptDescriptor } from '../shared/schemas/paid-effect';

const SERPER_SEARCH_URL = 'https://google.serper.dev/search';
export const SERPER_SEARCH_TIMEOUT_MS = 15_000;
export const SERPER_SEARCH_MAX_RESPONSE_BYTES = 1_048_576;

export interface SerperSearchResult {
  url: string;
  title: string;
  description: string;
}

export interface SerperSearchResponse {
  results: SerperSearchResult[];
  responseBytes: number;
  complete: true;
}

export class SerperSearchError extends Error {
  readonly code: 'credential_missing' | 'invalid_query' | 'cancelled' | 'unavailable' | 'malformed_response' | 'response_too_large' | 'contract_required';
  constructor(code: SerperSearchError['code'], message: string) {
    super(`${code}: ${message}`);
    this.name = 'SerperSearchError';
    this.code = code;
  }
}

function validateQuery(query: string): string {
  const value = query.trim();
  if (!value || value.length > 600 || value.split(/\s+/).length > 75) {
    throw new SerperSearchError('invalid_query', 'Serper queries must contain 1–600 characters and no more than 75 words.');
  }
  return value;
}

/** Real fixed-origin adapter; results are discovery clues only. POSTs `{ q, num }` with `X-API-KEY`, reads `organic[]` only. */
export async function searchSerperWeb(query: string, options: {
  count?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onDispatch?: () => void;
  paidEffectDescriptor?: PaidEffectAttemptDescriptor;
  maxResponseBytes?: number;
} = {}): Promise<SerperSearchResponse> {
  const maxResponseBytes = options.maxResponseBytes ?? SERPER_SEARCH_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > SERPER_SEARCH_MAX_RESPONSE_BYTES) {
    throw new SerperSearchError('invalid_query', 'Response byte limit must be a positive safe integer within the adapter maximum.');
  }
  const q = validateQuery(query);
  const count = options.count ?? 10;
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new SerperSearchError('invalid_query', 'Serper count must be 1–20.');
  }
  if (options.signal?.aborted) throw new SerperSearchError('cancelled', 'Search was cancelled before dispatch.');
  let credential: string | undefined;
  try { credential = getApiKey('serper_search')?.api_key; } catch { credential = undefined; }
  if (!credential) throw new SerperSearchError('credential_missing', 'Configure the Serper Search API key in server settings before acquisition can search.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), SERPER_SEARCH_TIMEOUT_MS);
  try {
    // T4: no contract-free Serper POST. Without a verified billing contract the
    // coordinator cannot reserve a bounded maximum — fail closed instead.
    const descriptor = options.paidEffectDescriptor;
    if (!descriptor) {
      throw new SerperSearchError('contract_required', 'Serper Search requires a verified billing contract; no unbounded search was dispatched.');
    }
    const response = await runPaidEffect({
      descriptor,
      signal: controller.signal,
      execute: async paidSignal => {
        if (paidSignal.aborted) throw new SerperSearchError('cancelled', 'Search was cancelled before dispatch.');
        options.onDispatch?.();
        const dispatchedResponse = await (options.fetchImpl ?? fetch)(SERPER_SEARCH_URL, {
          method: 'POST',
          headers: { 'X-API-KEY': credential, 'Content-Type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ q, num: count }),
          signal: paidSignal,
          redirect: 'error',
        });
        return { value: dispatchedResponse };
      },
    });
    if (!response.ok) throw new SerperSearchError('unavailable', `Serper Search returned HTTP ${response.status}. Check the configured subscription and service availability.`);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
      throw new SerperSearchError('response_too_large', 'Serper Search response exceeded the complete-response limit.');
    }
    if (!response.body) throw new SerperSearchError('malformed_response', 'Serper Search returned no response body.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let receivedBytes = 0;
    let text = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        receivedBytes += chunk.value.byteLength;
        if (receivedBytes > maxResponseBytes) {
          await reader.cancel();
          throw new SerperSearchError('response_too_large', 'Serper Search response exceeded the complete-response limit.');
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { throw new SerperSearchError('malformed_response', 'Serper Search returned malformed JSON.'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new SerperSearchError('malformed_response', 'Serper Search response has an invalid shape.');
    const rawResults = (payload as Record<string, unknown>).organic;
    if (!Array.isArray(rawResults)) throw new SerperSearchError('malformed_response', 'Serper Search response omitted organic results.');
    if (rawResults.length > count) throw new SerperSearchError('malformed_response', 'Serper Search returned more results than requested.');
    const results: SerperSearchResult[] = [];
    for (const raw of rawResults) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SerperSearchError('malformed_response', 'Serper Search returned an invalid result.');
      const row = raw as Record<string, unknown>;
      if (typeof row.link !== 'string' || typeof row.title !== 'string' || (row.snippet !== undefined && typeof row.snippet !== 'string')) {
        throw new SerperSearchError('malformed_response', 'Serper Search returned an incomplete result.');
      }
      let parsed: URL;
      try { parsed = new URL(row.link); } catch { throw new SerperSearchError('malformed_response', 'Serper Search returned an invalid result URL.'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new SerperSearchError('malformed_response', 'Serper Search returned a non-public URL scheme.');
      }
      results.push({ url: parsed.toString(), title: row.title, description: typeof row.snippet === 'string' ? row.snippet : '' });
    }
    return { results, responseBytes: receivedBytes, complete: true };
  } catch (error) {
    if (error instanceof SerperSearchError || error instanceof PaidEffectBudgetError) throw error;
    if (options.signal?.aborted) throw new SerperSearchError('cancelled', 'Search was cancelled.');
    if (controller.signal.aborted) throw new SerperSearchError('unavailable', 'Serper Search timed out or was interrupted.');
    throw new SerperSearchError('unavailable', 'Serper Search could not be reached.');
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}
