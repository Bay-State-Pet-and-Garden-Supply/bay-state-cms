import { acquireLocalSlot, releaseLocalSlot } from '../ai/local-runtime-coordinator';
import { getFullAiRoutingConfig } from '../db/repositories/provider-connection-repo';
import { getApiKey } from '../db/repositories/api-key-repo';
import { dispatchWorkloadChat } from '../ai/inference-dispatcher';
import { resolveWorkloadRoute, isConnectionUsable } from '../ai/provider-connections';
import type { AiTransport } from '../ai/provider-connections';
import {
  DEFAULT_LOCAL_VISION_MODEL,
  LEGACY_ROUTE_FALLBACK_VISION_MODEL,
  OLLAMA_VLM_SERVICE_NAME,
} from '../ai/vision-model-defaults';
import { redactTransportText } from '../classification/model-policy-gateway';

/** Minimal structural fetch signature — lets callers inject the PI
 *  policy-gateway bound fetch (P0-1). */
export type NetworkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Default per-attempt VLM transport timeout (ms). */
export const DEFAULT_OCR_TIMEOUT_MS = 120_000;

/**
 * Per-attempt timeout knob (packaging-OCR overhaul P2):
 * `BAYSTATE_CMS_OCR_TIMEOUT_MS` parsed once per `callVlm` invocation — an
 * integer > 0 wins; unparseable/non-positive/absent values fall back to the
 * 120s default.
 */
export function parseOcrTimeoutMs(
  raw: string | undefined = process.env.BAYSTATE_CMS_OCR_TIMEOUT_MS,
): number {
  if (raw !== undefined && /^\d+$/.test(raw.trim())) {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (parsed > 0) return parsed;
  }
  return DEFAULT_OCR_TIMEOUT_MS;
}

export interface VlmConfig {
  baseUrl: string;
  model: string;
  enabled: boolean;
  transport?: AiTransport;
  credential?: string;
  /**
   * Optional sampling options (packaging-OCR overhaul P3-T2, hallucination
   * mitigations). ADDITIVE + optional: when absent the request bodies are
   * byte-identical to pre-P3-T2 behavior.
   */
  options?: {
    temperature?: number;
    frequencyPenalty?: number;
  };
}

/**
 * Retrieve the active vision model configuration from the database.
 *
 * Resolves the connection-addressed `visionOcr` workload route WITH
 * inheritance (via `resolveWorkloadRoute`). If unconfigured or unusable,
 * falls back to the legacy `api_keys.ollama_vlm` row for backward compatibility.
 */
export function getVlmConfig(): VlmConfig | null {
  try {
    const config = getFullAiRoutingConfig();
    const route = resolveWorkloadRoute('visionOcr', config);
    const conn = config.connections[route.primary.connectionId];
    if (conn && isConnectionUsable(conn)) {
      return {
        baseUrl: conn.baseUrl,
        model: route.primary.modelId || LEGACY_ROUTE_FALLBACK_VISION_MODEL,
        enabled: true,
        transport: conn.transport,
        credential: conn.credential ?? undefined,
      };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[VlmClient] AI Compute routing resolution failed; falling back to legacy ollama_vlm row: ${redactTransportText(msg)}`);
  }

  // 2. Legacy fallback: api_keys.ollama_vlm
  const row = getApiKey(OLLAMA_VLM_SERVICE_NAME);
  if (row) {
    if (row.api_key !== 'enabled') {
      return null;
    }
    const rawBaseUrl = row.base_url || 'http://localhost:11434';
    const baseUrl = rawBaseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
    return {
      baseUrl,
      model: row.model || DEFAULT_LOCAL_VISION_MODEL,
      enabled: true,
      transport: 'ollama-native',
    };
  }
  return null;
}

/**
 * Sniff the image MIME type from the decoded base64 payload's magic header:
 * JPEG (FF D8 FF), GIF87a/GIF89a, PNG full 8-byte signature, WebP
 * (RIFF…WEBP). FIX-F review round 2: the payload is validated as CANONICAL
 * base64 (alphabet + padding structure) BEFORE decoding, and every signature
 * must be COMPLETE at a sensible minimum byte count — truncated or junk-
 * prefixed payloads fall through to the `image/jpeg` default (the historical
 * hardcoded value) instead of being classified from partial bytes.
 * Pure function; exported for unit tests.
 */
export function sniffImageMimeType(base64: string): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  const raw = String(base64 ?? '');
  // Canonical-base64 gate: only the standard alphabet, `=` padding only at
  // the end, and a length multiple of 4 decode unambiguously. Buffer.from is
  // lenient and would silently accept junk-prefixed input.
  if (raw.length === 0 || raw.length % 4 !== 0) return 'image/jpeg';
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) return 'image/jpeg';
  const buf = Buffer.from(raw, 'base64');
  // Round-trip check: canonical base64 must re-encode to itself (catches
  // trailing-bit misuse of the two `=` slots).
  if (buf.toString('base64') !== raw) return 'image/jpeg';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  // FIX-H round 3: EXACT GIF signatures only — any 6-byte prefix starting
  // with "GIF8" (e.g. "GIF8zz") must NOT classify as image/gif.
  if (
    buf.length >= 6 &&
    (buf.toString('latin1', 0, 6) === 'GIF87a' || buf.toString('latin1', 0, 6) === 'GIF89a')
  ) {
    return 'image/gif';
  }
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

/**
 * Result of a dispatcher-routed VLM call.
 */
export interface DispatchedVlmResult {
  content: string;
  /** The ModelTarget actually executed (primary or fallback), or null for the legacy direct path. */
  executedTarget: { connectionId: string; modelId: string } | null;
}

/**
 * Live VLM invocation with configured fallback + image data-sharing policy.
 *
 * Resolves the active vision configuration and:
 * - legacy Ollama-native route (`api_keys.ollama_vlm`): direct invocation
 *   (no dispatcher semantics — same behavior as before);
 * - OpenAI-compatible AI Compute route (explicit `visionOcr` route): routed
 *   through `dispatchWorkloadChat('visionOcr', …, { requiresImage: true })`
 *   so the configured fallback is actually executed and the image
 *   data-sharing policy is enforced (e.g. LAN primary down + Images =
 *   trusted_lan_allowed → cloud fallback denied; cloud_allowed → configured
 *   cloud VLM fallback used).
 *
 * This must ONLY be used for non-frozen, non-gateway-bound live OCR. Frozen
 * (run-bound) calls and Product Intelligence's gateway-bound `modelFetchFn`
 * path keep the exact-endpoint `callVlm` invocation.
 *
 * Post-review fixup 6: optional sampling options (temperature /
 * frequencyPenalty) thread through into the dispatcher request body via
 * `ChatCompletionOptions`, so the greedy-decoding default and the
 * repetition-penalty retry apply on the openai-compatible dispatcher path
 * exactly as they do on the direct transports. Fields are only added when
 * defined, so callers passing no options keep byte-identical bodies.
 */
export async function callVlmWithDispatcher(
  prompt: string,
  imageBase64: string,
  options?: VlmConfig['options'],
): Promise<DispatchedVlmResult> {
  const config = getVlmConfig();
  if (!config || !config.enabled) {
    throw new Error('VLM vision model is not enabled or configured.');
  }

  if (config.transport === 'ollama-native') {
    // Legacy Ollama-native endpoint: no dispatcher/fallback semantics.
    // Sampling options MUST still reach the body — the greedy temperature=0
    // default and repetition-penalty retry apply on ALL live transports.
    const content = await callVlm(prompt, imageBase64, options ? { ...config, options } : config);
    return { content, executedTarget: null };
  }

  // OpenAI-compatible: reached when the resolved AI Compute visionOcr route
  // (explicit OR inherited from the catalog default) points at an
  // openai-compatible connection. The dispatcher re-resolves the same route
  // with `resolveWorkloadRoute`, so primary/fallback and the image
  // data-sharing policy stay consistent with getVlmConfig().
  const dataUri = imageBase64.startsWith('data:') ? imageBase64 : `data:${sniffImageMimeType(imageBase64)};base64,${imageBase64}`;
  const result = await dispatchWorkloadChat(
    'visionOcr',
    [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUri } },
        ],
      },
    ],
    { requiresImage: true,
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.frequencyPenalty !== undefined ? { frequencyPenalty: options.frequencyPenalty } : {}) },
  );
  return { content: result.content, executedTarget: result.executedTarget };
}

/**
 * Invoke the vision model (Ollama native or OpenAI-compatible LM Studio endpoint).
 */
export async function callVlm(
  prompt: string,
  imageBase64: string,
  configOverride?: VlmConfig,
  fetchFn: NetworkFetch = fetch,
): Promise<string> {
  const config = configOverride || getVlmConfig();
  if (!config || !config.enabled) {
    throw new Error('VLM vision model is not enabled or configured.');
  }

  const isOpenAi = config.transport === 'openai-compatible' || config.baseUrl.includes('/v1');
  const cleanBase = config.baseUrl.replace(/\/+$/, '');
  const url = isOpenAi ? `${cleanBase}/chat/completions` : `${cleanBase}/api/chat`;

  console.log(`[VlmClient] Invoking vision model "${config.model}" via ${isOpenAi ? 'OpenAI-compatible' : 'Ollama-native'} at ${url}`);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (config.credential) {
    headers.Authorization = `Bearer ${config.credential}`;
  }

  const dataUri = imageBase64.startsWith('data:') ? imageBase64 : `data:${sniffImageMimeType(imageBase64)};base64,${imageBase64}`;

  // P3-T2: apply optional sampling options per transport. Absent options ⇒
  // byte-identical bodies as before (fields are only added when defined).
  const sampling = config.options ?? {};
  const hasSampling = sampling.temperature !== undefined || sampling.frequencyPenalty !== undefined;

  const body = isOpenAi
    ? JSON.stringify({
        model: config.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataUri } },
            ],
          },
        ],
        stream: false,
        ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}),
        ...(sampling.frequencyPenalty !== undefined ? { frequency_penalty: sampling.frequencyPenalty } : {}),
      })
    : JSON.stringify({
        model: config.model,
        messages: [
          {
            role: 'user',
            content: prompt,
            images: [imageBase64.replace(/^data:image\/[a-z]+;base64,/, '')],
          },
        ],
        stream: false,
        // Ollama-native carries sampling inside body.options (snake_case).
        ...(hasSampling
          ? {
              options: {
                ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}),
                ...(sampling.frequencyPenalty !== undefined ? { frequency_penalty: sampling.frequencyPenalty } : {}),
              },
            }
          : {}),
      });

  await acquireLocalSlot('ollama');
  const timeoutMs = parseOcrTimeoutMs();
  try {
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err: unknown) {
      const errorName = err instanceof Error ? err.name : '';
      if (errorName === 'AbortError' || errorName === 'TimeoutError') {
        throw new Error(`VLM request timed out after ${Math.round(timeoutMs / 1000)}s`, { cause: err });
      }
      throw err;
    }

    if (response.status >= 300 && response.status < 400) {
      throw new Error(`HTTP redirect (${response.status}) forbidden on VLM connection (Anti-SSRF).`);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`VLM request failed: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as any;
    const content = isOpenAi
      ? data?.choices?.[0]?.message?.content
      : data?.message?.content;

    if (!content) {
      throw new Error('VLM returned an empty response.');
    }

    return content.trim();
  } finally {
    releaseLocalSlot('ollama');
  }
}
