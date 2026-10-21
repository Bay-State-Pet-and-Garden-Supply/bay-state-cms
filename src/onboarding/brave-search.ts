import { getApiKey } from '../db/repositories/api-key-repo';

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
export const BRAVE_SEARCH_TIMEOUT_MS = 15_000;
export const BRAVE_SEARCH_MAX_RESPONSE_BYTES = 1_048_576;

export interface BraveSearchResult {
  url: string;
  title: string;
  description: string;
}

export interface BraveSearchResponse {
  results: BraveSearchResult[];
  responseBytes: number;
  complete: true;
}

export class BraveSearchError extends Error {
  readonly code: 'credential_missing' | 'invalid_query' | 'cancelled' | 'unavailable' | 'malformed_response' | 'response_too_large';
  constructor(code: BraveSearchError['code'], message: string) {
    super(`${code}: ${message}`);
    this.name = 'BraveSearchError';
    this.code = code;
  }
}

function validateQuery(query: string): string {
  const value = query.trim();
  if (!value || value.length > 600 || value.split(/\s+/).length > 75) {
    throw new BraveSearchError('invalid_query', 'Brave queries must contain 1–600 characters and no more than 75 words.');
  }
  return value;
}

/** Real fixed-origin adapter; results are discovery clues only. Uses `q`, `count` (1–20), `offset` (0–9), no spellcheck/decorations, and `web` only. */
export async function searchBraveWeb(query: string, options: {
  count?: number;
  offset?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onDispatch?: () => void;
  maxResponseBytes?: number;
} = {}): Promise<BraveSearchResponse> {
  const maxResponseBytes = options.maxResponseBytes ?? BRAVE_SEARCH_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > BRAVE_SEARCH_MAX_RESPONSE_BYTES) {
    throw new BraveSearchError('invalid_query', 'Response byte limit must be a positive safe integer within the adapter maximum.');
  }
  const q = validateQuery(query);
  const count = options.count ?? 10;
  const offset = options.offset ?? 0;
  if (!Number.isInteger(count) || count < 1 || count > 20 || !Number.isInteger(offset) || offset < 0 || offset > 9) {
    throw new BraveSearchError('invalid_query', 'Brave count must be 1–20 and offset must be 0–9.');
  }
  if (options.signal?.aborted) throw new BraveSearchError('cancelled', 'Search was cancelled before dispatch.');
  let credential: string | undefined;
  try { credential = getApiKey('brave_search')?.api_key; } catch { credential = undefined; }
  if (!credential) throw new BraveSearchError('credential_missing', 'Configure the Brave Search API key in server settings before acquisition can search.');
  const url = new URL(BRAVE_SEARCH_URL);
  url.searchParams.set('q', q);
  url.searchParams.set('count', String(count));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('spellcheck', 'false');
  url.searchParams.set('text_decorations', 'false');
  url.searchParams.set('result_filter', 'web');
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), BRAVE_SEARCH_TIMEOUT_MS);
  try {
    if (options.signal?.aborted) throw new BraveSearchError('cancelled', 'Search was cancelled before dispatch.');
    options.onDispatch?.();
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: 'GET',
      headers: { 'x-subscription-token': credential, accept: 'application/json' },
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) throw new BraveSearchError('unavailable', `Brave Search returned HTTP ${response.status}. Check the configured subscription and service availability.`);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
      throw new BraveSearchError('response_too_large', 'Brave Search response exceeded the complete-response limit.');
    }
    if (!response.body) throw new BraveSearchError('malformed_response', 'Brave Search returned no response body.');
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
          throw new BraveSearchError('response_too_large', 'Brave Search response exceeded the complete-response limit.');
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { throw new BraveSearchError('malformed_response', 'Brave Search returned malformed JSON.'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new BraveSearchError('malformed_response', 'Brave Search response has an invalid shape.');
    const web = (payload as Record<string, unknown>).web;
    const rawResults = web && typeof web === 'object' && !Array.isArray(web)
      ? (web as Record<string, unknown>).results : undefined;
    if (!Array.isArray(rawResults)) throw new BraveSearchError('malformed_response', 'Brave Search response omitted web results.');
    if (rawResults.length > count) throw new BraveSearchError('malformed_response', 'Brave Search returned more results than requested.');
    const results: BraveSearchResult[] = [];
    for (const raw of rawResults) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BraveSearchError('malformed_response', 'Brave Search returned an invalid result.');
      const row = raw as Record<string, unknown>;
      if (typeof row.url !== 'string' || typeof row.title !== 'string' || typeof row.description !== 'string') {
        throw new BraveSearchError('malformed_response', 'Brave Search returned an incomplete result.');
      }
      let parsed: URL;
      try { parsed = new URL(row.url); } catch { throw new BraveSearchError('malformed_response', 'Brave Search returned an invalid result URL.'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new BraveSearchError('malformed_response', 'Brave Search returned a non-public URL scheme.');
      }
      results.push({ url: parsed.toString(), title: row.title, description: row.description });
    }
    return { results, responseBytes: receivedBytes, complete: true };
  } catch (error) {
    if (error instanceof BraveSearchError) throw error;
    if (options.signal?.aborted) throw new BraveSearchError('cancelled', 'Search was cancelled.');
    if (controller.signal.aborted) throw new BraveSearchError('unavailable', 'Brave Search timed out or was interrupted.');
    throw new BraveSearchError('unavailable', 'Brave Search could not be reached.');
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}
