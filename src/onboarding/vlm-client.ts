import { acquireLocalSlot, releaseLocalSlot } from '../ai/local-runtime-coordinator';
import { recordConnectionQuotaExhaustion } from '../ai/connection-health-monitor';
import { getFullAiRoutingConfig } from '../db/repositories/provider-connection-repo';
import { getApiKey } from '../db/repositories/api-key-repo';
import { dispatchWorkloadChat } from '../ai/inference-dispatcher';
import { resolveWorkloadRoute, isConnectionUsable, isLoopbackHost, isSystemOneConnection } from '../ai/provider-connections';
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
  /**
   * Actionable routing note (issue #333): set when the dispatcher path did
   * NOT serve from the configured primary — a cloud primary that failed
   * closed on quota (HTTP 429) was served from the enabled local route
   * instead. Callers persist this in result metadata so the fallback is an
   * attributable outcome, not just a log line.
   */
  warning?: string;
}

/**
 * True when the PRIMARY failure behind a dispatcher throw is cloud quota
 * exhaustion (HTTP 429) — issue #333 P2 alert attribution.
 *
 * The dispatcher preserves the primary status as an own `primaryStatusCode`
 * prop on every post-primary-failure throw (fallback-execution failures AND
 * fallback rejections) — always set there, even when the primary had no
 * status, so its PRESENCE means the outer error is the fallback's and the
 * cause-chain walk below must NOT run (it would see the fallback's own
 * status and misattribute it). Absent only when the throw IS the primary
 * failure (or wraps just it, e.g. the fail-closed wrapper): then the first
 * `statusCode` in the `cause` chain is the primary's own. A non-typed
 * primary carrying `HTTP 429` prose matches as a last resort.
 */
function isPrimaryQuotaFailure(err: unknown): boolean {
  if (err !== null && (typeof err === 'object' || typeof err === 'function')) {
    if ('primaryStatusCode' in err) {
      return err.primaryStatusCode === 429;
    }
    // Bounded walk (depth 10 doubles as cycle protection — no Set needed).
    let cur: unknown = err;
    for (let depth = 0; depth < 10; depth += 1) {
      if (cur === null || (typeof cur !== 'object' && typeof cur !== 'function')) break;
      if ('statusCode' in cur && cur.statusCode === 429) return true;
      if (!('cause' in cur)) break;
      cur = cur.cause;
    }
  }
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /HTTP 429\b/.test(message);
}

/**
 * Pin the operator-visible quota alert for a cloud-primary 429 (issue #333).
 *
 * Runs BEFORE fallback eligibility is considered so the pin is independent
 * of the fallback outcome. Best-effort: pinning never changes the throw —
 * the caller still throws or falls back exactly as before.
 */
function pinCloudQuotaAlert(): void {
  let primaryTarget = { connectionId: 'unknown', modelId: 'unknown' };
  let primaryIsCloud = false;
  try {
    const full = getFullAiRoutingConfig();
    const route = resolveWorkloadRoute('visionOcr', full);
    primaryTarget = route.primary;
    primaryIsCloud = full.connections[route.primary.connectionId]?.trustZone === 'cloud';
    if (!primaryIsCloud) return;
  } catch {
    // Unreadable routing config: still pin against the unknown primary so
    // the 429 leaves an actionable trace rather than only a log line.
  }
  const warning = `Cloud quota exhausted (HTTP 429) on ${primaryTarget.connectionId}:${primaryTarget.modelId}: top up cloud credits or route the visionOcr primary to the local VLM.`;
  console.warn(`[VlmClient] ${warning}`);
  // Operator-visible alert: pin the quota condition onto the
  // dashboard-rendered per-connection health surface (AI Compute settings
  // renders health.errorMessage per connection) IN ADDITION to the
  // console.warn + parser-note trace. Display-only: `misconfigured`
  // records never feed availability failover.
  try {
    recordConnectionQuotaExhaustion(primaryTarget.connectionId, warning);
  } catch {
    // Alert pinning is best-effort; the throw/fallback stands regardless.
  }
}

/**
 * Enabled local VLM target for cloud-quota fallback (issue #333).
 *
 * Preference mirrors the frozen-plan capture (`captureLocalVlmConfig` → the
 * working local Ollama route): the legacy `api_keys.ollama_vlm` row when
 * enabled, else the first enabled + usable loopback AI Compute connection
 * (System One typed-judgment connections never serve vision). Loopback is
 * permitted under every image data-sharing policy, so this fallback never
 * violates the data-sharing boundary. Returns null when no enabled local
 * route exists — callers then rethrow the quota error unchanged.
 */
function resolveEnabledLocalVlmTarget(): { connectionId: string; config: VlmConfig } | null {
  try {
    const row = getApiKey(OLLAMA_VLM_SERVICE_NAME);
    if (row && row.api_key === 'enabled') {
      const rawBaseUrl = row.base_url || 'http://localhost:11434';
      const baseUrl = rawBaseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
      return {
        connectionId: OLLAMA_VLM_SERVICE_NAME,
        config: {
          baseUrl,
          model: row.model || DEFAULT_LOCAL_VISION_MODEL,
          enabled: true,
          transport: 'ollama-native',
        },
      };
    }
  } catch {
    // Legacy lookup failure must never block the AI Compute scan below.
  }
  try {
    const full = getFullAiRoutingConfig();
    for (const conn of Object.values(full.connections)) {
      if (!isConnectionUsable(conn) || isSystemOneConnection(conn)) continue;
      if (conn.transport !== 'openai-compatible' && conn.transport !== 'ollama-native') continue;
      let hostname = '';
      try {
        hostname = new URL(conn.baseUrl).hostname;
      } catch {
        continue;
      }
      if (!isLoopbackHost(hostname)) continue;
      return {
        connectionId: conn.id,
        config: {
          baseUrl: conn.baseUrl,
          model: LEGACY_ROUTE_FALLBACK_VISION_MODEL,
          enabled: true,
          transport: conn.transport,
          ...(conn.credential ? { credential: conn.credential } : {}),
        },
      };
    }
  } catch {
    // Unreadable routing config → no local fallback.
  }
  return null;
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
  try {
    const dispatchResult = await dispatchWorkloadChat(
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
    // A dispatcher-served configured-availability fallback still consumed a
    // cloud-primary 429 to get there: surface the same actionable alert on
    // the primary, so the quota condition is visible even though OCR evidence
    // survived via the fallback. Cause-checked on the primary status the
    // dispatcher preserved (issue #333 P2): a primary timeout/connection
    // failure/503 served via fallback must NOT pin "quota exhausted".
    if (dispatchResult.wasFallback && !dispatchResult.warning && dispatchResult.primaryStatusCode === 429) {
      pinCloudQuotaAlert();
    }
    // Any success through the dispatcher returns as-is: a configured
    // fallback served by the dispatcher resolves here (dispatcher-owned
    // behavior), while the throw paths below cover every remaining
    // cloud-primary 429 — with or without a dispatcher fallback configured.
    return { content: dispatchResult.content, executedTarget: dispatchResult.executedTarget };
  } catch (err) {
    // Issue #333: quota failure on ANY cloud primary surfaces an actionable
    // alert, not just a log line. The alert pins FIRST — at this primary-
    // error boundary, before fallback eligibility is considered — so every
    // cloud-primary 429 lands on the dashboard-rendered per-connection
    // health surface whether or not a local route exists (no-local-route
    // throws still carry the pin) and whether fallback later succeeds, fails
    // differently, or rejects outright (primary 429 + fallback 503 still
    // alerts; primary 429 + System One fallback rejection still alerts).
    // Decided on the PRIMARY failure only — the status the dispatcher
    // preserved — so a primary timeout/503 served or followed by a fallback
    // 429 never pins "quota exhausted".
    if (!isPrimaryQuotaFailure(err)) throw err;
    pinCloudQuotaAlert();
    // Local rescue for the dispatcher-unserved case only (no configured
    // fallback in the resolved route): fall back to the enabled local route
    // — the same local-first preference frozen plans capture. A configured
    // fallback present (or a non-cloud primary) rethrows unchanged;
    // frozen-plan (run-bound) calls never reach this path (they use
    // exact-endpoint `callVlm` directly).
    let primaryTarget = { connectionId: 'unknown', modelId: 'unknown' };
    let primaryIsCloud = false;
    let hasConfiguredFallback = true;
    try {
      const full = getFullAiRoutingConfig();
      const route = resolveWorkloadRoute('visionOcr', full);
      primaryTarget = route.primary;
      primaryIsCloud = full.connections[route.primary.connectionId]?.trustZone === 'cloud';
      hasConfiguredFallback = route.fallback !== null;
    } catch {
      throw err;
    }
    if (!primaryIsCloud || hasConfiguredFallback) throw err;
    const local = resolveEnabledLocalVlmTarget();
    if (!local) throw err;
    const warning = `Cloud quota exhausted (HTTP 429) on ${primaryTarget.connectionId}:${primaryTarget.modelId}: top up cloud credits or route the visionOcr primary to the local VLM. Falling back to local route ${local.connectionId}.`;
    console.warn(`[VlmClient] ${warning}`);
    const content = await callVlm(prompt, imageBase64, options ? { ...local.config, options } : local.config);
    return { content, executedTarget: { connectionId: local.connectionId, modelId: local.config.model }, warning };
  }
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
