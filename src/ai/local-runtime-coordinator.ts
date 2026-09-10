/**
 * Local Runtime Coordinator for Bay State AI Infrastructure.
 *
 * Provides a unified local concurrency gate (semaphore) shared across
 * local text LLM requests and vision VLM requests. Concurrency is operator-configured
 * via process.env.BAYSTATE_CMS_MAX_LOCAL_CONCURRENCY (defaults to 1).
 *
 * Ollama remains the authority over loaded models; this coordinator tracks queue depth,
 * active requests, and queries Ollama runtime status without app-level model cache management.
 */

import { getCircuitBreakerStats, type CircuitBreakerRouteStats } from '../onboarding/vlm-circuit-breaker';

let activeRequests = 0;
const requestQueue: Array<() => void> = [];

/**
 * Resolve max local concurrency from environment variable or default to 1.
 */
export function getMaxLocalConcurrency(): number {
  const envVal = process.env.BAYSTATE_CMS_MAX_LOCAL_CONCURRENCY;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 1;
}

/**
 * Acquire a slot for local model execution.
 * Only blocks for provider 'ollama'; cloud providers proceed without queuing.
 */
export async function acquireLocalSlot(provider: string): Promise<void> {
  if (provider !== 'ollama') return;

  const maxConcurrency = getMaxLocalConcurrency();
  while (activeRequests >= maxConcurrency) {
    await new Promise<void>((resolve) => requestQueue.push(resolve));
  }
  activeRequests += 1;
}

/**
 * Release a local model execution slot.
 */
export function releaseLocalSlot(provider: string): void {
  if (provider !== 'ollama') return;

  activeRequests = Math.max(0, activeRequests - 1);
  const next = requestQueue.shift();
  if (next) {
    next();
  }
}

/**
 * Current local concurrency counters for diagnostics & monitoring.
 */
export function getLocalConcurrencyStats() {
  return {
    maxConcurrency: getMaxLocalConcurrency(),
    activeRequests,
    queuedRequests: requestQueue.length,
  };
}

export interface LocalRuntimeHealth {
  concurrency: {
    maxConcurrency: number;
    activeRequests: number;
    queuedRequests: number;
  };
  circuitBreakers: Record<string, CircuitBreakerRouteStats>;
}

/**
 * Additive combined health view (P1-T2): local concurrency stats merged with
 * the VLM circuit-breaker snapshot for observability. Read-only; additive
 * only — existing exports and signatures are unchanged.
 */
export function getLocalRuntimeHealth(): LocalRuntimeHealth {
  return {
    concurrency: getLocalConcurrencyStats(),
    circuitBreakers: getCircuitBreakerStats(),
  };
}

export interface RunningModelInfo {
  name: string;
  size?: number;
  digest?: string;
}

export interface LocalRuntimeStatus {
  maxConcurrency: number;
  activeRequests: number;
  queuedRequests: number;
  connected: boolean;
  runningModels: RunningModelInfo[];
}

/**
 * Query Ollama /api/ps endpoint to inspect runtime health and loaded models.
 */
export async function getLocalRuntimeStatus(
  baseUrl = 'http://localhost:11434',
): Promise<LocalRuntimeStatus> {
  const stats = getLocalConcurrencyStats();
  const cleanUrl = baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, '');

  try {
    const res = await fetch(`${cleanUrl}/api/ps`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) {
      return {
        ...stats,
        connected: false,
        runningModels: [],
      };
    }

    const data = (await res.json()) as {
      models?: Array<{ name?: string; model?: string; size?: number; digest?: string }>;
    };

    const runningModels: RunningModelInfo[] = (data.models || []).map((m) => ({
      name: m.name || m.model || 'unknown',
      size: m.size,
      digest: m.digest,
    }));

    return {
      ...stats,
      connected: true,
      runningModels,
    };
  } catch {
    return {
      ...stats,
      connected: false,
      runningModels: [],
    };
  }
}

/** Reset internal coordinator state (primarily for test suite isolation). */
export function _resetLocalCoordinatorState(): void {
  activeRequests = 0;
  requestQueue.length = 0;
}
