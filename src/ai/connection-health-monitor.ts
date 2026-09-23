/**
 * Connection Health Monitor & Dynamic Model Discovery.
 *
 * Implements background health probing via /v1/models (or /api/tags),
 * cached model enumeration, and fast availability vs misconfiguration classification.
 */

import type { ProviderConnection } from './provider-connections';
import { validateConnectionTrustZone } from './provider-connections';
import { checkSystemOneModelPin } from './systemone-transport';

export interface DiscoveredModel {
  id: string;
  label?: string;
  ownedBy?: string;
  supportsVision?: boolean;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
}

export type ConnectionHealthStatus = 'online' | 'unreachable' | 'misconfigured';

export interface ConnectionHealthReport {
  connectionId: string;
  status: ConnectionHealthStatus;
  latencyMs: number;
  models: DiscoveredModel[];
  lastChecked: string;
  errorMessage?: string;
}

export interface ModelAvailabilityCheck {
  available: boolean;
  connectionStatus: ConnectionHealthStatus;
  isModelPresent: boolean;
  warning?: string;
}

// In-memory cache for health reports (TTL: 20s)
const HEALTH_CACHE = new Map<string, { report: ConnectionHealthReport; expiresAt: number }>();
const CACHE_TTL_MS = 20_000;

/**
 * Heuristically detect model capabilities from model ID naming conventions.
 *
 * Exported for reuse by model-capability consumers (e.g. the Store Manager
 * model resolver) that must classify discovered models without a network
 * round trip.
 */
export function inferModelCapabilities(modelId: string): {
  supportsVision: boolean;
  supportsTools: boolean;
  supportsReasoning: boolean;
} {
  const m = modelId.toLowerCase();
  const supportsVision = m.includes('vl') || m.includes('vision') || m.includes('4o') || m.includes('gemma-4') || m.includes('gemma4');
  const supportsTools = !m.includes('base') && (m.includes('qwen') || m.includes('gpt') || m.includes('gemma') || m.includes('muse') || m.includes('deepseek'));
  const supportsReasoning = m.includes('r1') || m.includes('thinking') || m.includes('reasoner') || m.includes('qwen3') || m.includes('gemma-4') || m.includes('muse');

  return { supportsVision, supportsTools, supportsReasoning };
}

export function isConnectionCachedUnhealthy(connectionId: string): boolean {
  // Only 'unreachable' is an availability condition. A cached 'misconfigured'
  // state must NEVER be converted into an availability failure — that would
  // permit fallback on a policy/misconfiguration problem (fail-open).
  return getCachedConnectionHealth(connectionId) === 'unreachable';
}

/**
 * Returns the cached health status for a connection within its TTL, or
 * `null` when no valid cached report exists. Exposes the ACTUAL status so
 * callers can distinguish 'unreachable' (fast-failover) from 'misconfigured'
 * (never an availability failure — re-validate at transport instead).
 */
export function getCachedConnectionHealth(connectionId: string): ConnectionHealthStatus | null {
  const cached = HEALTH_CACHE.get(connectionId);
  if (!cached || cached.expiresAt <= Date.now()) return null;
  return cached.report.status;
}

/**
 * Probes the /v1/models endpoint for an OpenAI-compatible connection.
 */
export async function probeConnectionHealth(
  conn: ProviderConnection,
  forceRefresh = false,
): Promise<ConnectionHealthReport> {
  const now = Date.now();
  const cached = HEALTH_CACHE.get(conn.id);
  if (!forceRefresh && cached && cached.expiresAt > now) {
    return cached.report;
  }

  // Validate Trust Zone and Host Pinning first (fail closed on policy)
  try {
    validateConnectionTrustZone(conn);
  } catch (err: any) {
    const report: ConnectionHealthReport = {
      connectionId: conn.id,
      status: 'misconfigured',
      latencyMs: 0,
      models: [],
      lastChecked: new Date().toISOString(),
      errorMessage: `Policy validation error: ${err.message}`,
    };
    HEALTH_CACHE.set(conn.id, { report, expiresAt: now + CACHE_TTL_MS });
    return report;
  }

  // Typed-judgment (System One) connections probe GET /models on the same
  // base URL; the parser below accepts the documented models[].name shape.
  const startTime = Date.now();
  const timeoutMs = conn.connectTimeoutMs ?? 2000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const cleanBase = conn.baseUrl.replace(/\/+$/, '');
  const url = `${cleanBase}/models`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'BaystateCMS-HealthProbe/1.0',
  };
  if (conn.credential) {
    headers.Authorization = `Bearer ${conn.credential}`;
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: controller.signal,
    });
    clearTimeout(timer);
    const latencyMs = Date.now() - startTime;

    if (response.status >= 300 && response.status < 400) {
      const report: ConnectionHealthReport = {
        connectionId: conn.id,
        status: 'misconfigured',
        latencyMs,
        models: [],
        lastChecked: new Date().toISOString(),
        errorMessage: `HTTP Redirect (${response.status}) forbidden on AI connection (Anti-SSRF).`,
      };
      HEALTH_CACHE.set(conn.id, { report, expiresAt: now + CACHE_TTL_MS });
      return report;
    }

    if (response.status === 401 || response.status === 403) {
      const report: ConnectionHealthReport = {
        connectionId: conn.id,
        status: 'misconfigured',
        latencyMs,
        models: [],
        lastChecked: new Date().toISOString(),
        errorMessage: `Authentication failed (HTTP ${response.status}). Check API key/credential.`,
      };
      HEALTH_CACHE.set(conn.id, { report, expiresAt: now + CACHE_TTL_MS });
      return report;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      const report: ConnectionHealthReport = {
        connectionId: conn.id,
        status: 'misconfigured',
        latencyMs,
        models: [],
        lastChecked: new Date().toISOString(),
        errorMessage: `HTTP ${response.status}: ${errorText.slice(0, 150)}`,
      };
      HEALTH_CACHE.set(conn.id, { report, expiresAt: now + CACHE_TTL_MS });
      return report;
    }

    const data: unknown = await response.json();
    const rawList: unknown[] = Array.isArray(data) ? data
      : (data !== null && typeof data === 'object' && 'data' in data && Array.isArray(data.data) ? data.data
      : (data !== null && typeof data === 'object' && 'models' in data && Array.isArray(data.models) ? data.models : []));
    const parsedModels: Array<DiscoveredModel | null> = rawList
      .map((item: unknown): DiscoveredModel | null => {
        if (item === null || typeof item !== 'object') return null;
        const record = item as Record<string, unknown>;
        const rawId = typeof record.id === 'string' ? record.id
          : (typeof record.name === 'string' ? record.name : null);
        if (!rawId) return null;
        const id: string = rawId;
        const caps = inferModelCapabilities(id);
        const ownedBy = typeof record.owned_by === 'string' ? record.owned_by : undefined;
        const model: DiscoveredModel = {
          id,
          label: id,
          ownedBy,
          ...caps,
        };
        return model;
      });
    const models: DiscoveredModel[] = parsedModels.filter((m): m is DiscoveredModel => m !== null);

    const report: ConnectionHealthReport = {
      connectionId: conn.id,
      status: 'online',
      latencyMs,
      models,
      lastChecked: new Date().toISOString(),
    };
    HEALTH_CACHE.set(conn.id, { report, expiresAt: now + CACHE_TTL_MS });
    return report;
  } catch (err: any) {
    clearTimeout(timer);
    const latencyMs = Date.now() - startTime;
    const isTimeout = err?.name === 'AbortError' || err?.name === 'TimeoutError';
    const report: ConnectionHealthReport = {
      connectionId: conn.id,
      status: 'unreachable',
      latencyMs,
      models: [],
      lastChecked: new Date().toISOString(),
      errorMessage: isTimeout
        ? `Connection timed out after ${timeoutMs}ms (Host offline or unreachable).`
        : `Network error: ${err?.message || 'Connection refused'}`,
    };
    HEALTH_CACHE.set(conn.id, { report, expiresAt: now + CACHE_TTL_MS });
    return report;
  }
}

/**
 * Checks if a specific model is present on a connection.
 * Distinguishes between connection unavailability and model misconfiguration.
 *
 * Pinned-model semantics (TypeSafe contract): versioned pins are accepted by
 * the API whether or not discovery lists them, and discovery currently lists
 * aliases only. So for System One connections an exact discovered match OR
 * the evaluated known pin passes, and anything else is an actionable
 * unknown-pin error (never an alias substitution). Documented aliases pass
 * only via an exact discovered match — never as known pins. Chat transports
 * keep the existing substring behavior.
 */
export async function checkModelAvailability(
  conn: ProviderConnection,
  modelId: string,
): Promise<ModelAvailabilityCheck> {
  const health = await probeConnectionHealth(conn);
  if (health.status !== 'online') {
    return {
      available: false,
      connectionStatus: health.status,
      isModelPresent: false,
      warning: `Connection "${conn.label}" is ${health.status}: ${health.errorMessage ?? 'Unavailable'}`,
    };
  }

  if (conn.transport === 'systemone') {
    const target = modelId.trim();
    const exactMatch = health.models.some(m => m.id === target);
    if (exactMatch) {
      return { available: true, connectionStatus: 'online', isModelPresent: true };
    }
    const pin = checkSystemOneModelPin(target);
    if (pin.ok && pin.kind === 'known_pin') {
      return { available: true, connectionStatus: 'online', isModelPresent: true };
    }
    return {
      available: false,
      connectionStatus: 'online',
      isModelPresent: false,
      warning: pin.message,
    };
  }

  // Model ID match (case-insensitive or exact)
  const target = modelId.trim().toLowerCase();
  const match = health.models.find(m => m.id.toLowerCase() === target || m.id.toLowerCase().includes(target));

  if (!match) {
    return {
      available: false,
      connectionStatus: 'online',
      isModelPresent: false,
      warning: `Model "${modelId}" is not loaded or not found on "${conn.label}". Route may be misconfigured.`,
    };
  }

  return {
    available: true,
    connectionStatus: 'online',
    isModelPresent: true,
  };
}

/**
 * Clears the health cache for a connection or all connections.
 */
export function clearHealthCache(connectionId?: string): void {
  if (connectionId) {
    HEALTH_CACHE.delete(connectionId);
  } else {
    HEALTH_CACHE.clear();
  }
}
