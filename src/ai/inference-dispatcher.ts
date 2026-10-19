/**
 * Inference Dispatcher with Resilient Failover & Policy Enforcement.
 *
 * Executes AI workloads against connection-addressed ModelTargets with
 * availability failover, data sharing policy validation, and misconfiguration tracking.
 */

import type {
  ProviderConnection,
  ModelTarget,
  AiRoutingConfig,
  ResolvedWorkloadRoute,
} from './provider-connections';
import {
  resolveWorkloadRoute,
  isTargetPermittedByPolicy,
  isSystemOneConnection,
} from './provider-connections';
import { getFullAiRoutingConfig } from '../db/repositories/provider-connection-repo';
import {
  executeOpenAiChat,
  AiAvailabilityError,
  AiMisconfigurationError,
  AiPolicyDeniedError,
  type ChatMessage,
  type ChatCompletionOptions,
} from './network-transport';
import {
  getCachedConnectionHealth,
  probeConnectionHealth,
} from './connection-health-monitor';
import {
  insertAiModelCallStart,
  completeAiModelCall,
  insertTerminalAiModelCall,
} from '../db/repositories/ai-model-call-repo';
import { computeApiCost } from './model-pricing';

export interface DispatchExecutionResult {
  content: string;
  toolCalls?: any[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  executedTarget: ModelTarget;
  wasFallback: boolean;
  warning?: string;
  /**
   * HTTP status of the primary failure that triggered fallback (issue #333:
   * cause precision). Set on every fallback-served result; undefined on
   * primary-served results. Lets callers pin quota alerts only when the
   * primary actually 429'd — a primary timeout/503 served via fallback must
   * NOT pin "quota exhausted". Preserved through fallback success, fallback
   * failure, AND fallback rejection: every post-primary-failure throw carries
   * it as an own `primaryStatusCode` prop (always set, even undefined) plus
   * the primary error as `cause`.
   */
  primaryStatusCode?: number;
}

export interface DispatchWorkloadOptions extends ChatCompletionOptions {
  requiresImage?: boolean;
  routingConfig?: AiRoutingConfig;
  /**
   * General AI-call telemetry (`ai_model_calls`). When `task` is set, every
   * resolved target (primary AND fallback) records a `started` row before
   * transport and a terminal row on every path — policy denials, failures,
   * and successes — so dispatcher-executed live calls get identical
   * attribution to legacy calls. Optional: callers that do not opt in are
   * unaffected.
   */
  telemetry?: {
    workspaceId?: string;
    task?: string;
  };
}

/**
 * Dispatches an AI request for a specific named workload.
 */
export async function dispatchWorkloadChat(
  workload: keyof AiRoutingConfig['workloads'],
  messages: ChatMessage[],
  options: DispatchWorkloadOptions = {},
): Promise<DispatchExecutionResult> {
  const config = options.routingConfig ?? getFullAiRoutingConfig();
  const route: ResolvedWorkloadRoute = resolveWorkloadRoute(workload, config);

  const { primary, fallback, textDataSharing, imageDataSharing, terminalBehavior } = route;
  const requiresImage = Boolean(options.requiresImage);

  // Telemetry context (optional). Live callers pass workspaceId + task so
  // dispatcher executions are attributed in `ai_model_calls`.
  const telemetryTask = options.telemetry?.task;
  const telemetryWorkspaceId = options.telemetry?.workspaceId ?? 'default';
  const localityOf = (conn: ProviderConnection): 'local' | 'cloud' =>
    conn.trustZone === 'cloud' ? 'cloud' : 'local';
  const terminalize = (callId: string, update: Parameters<typeof completeAiModelCall>[1]): void => {
    completeAiModelCall(callId, update);
  };
  // Pre-transport policy denials leave a durable terminal row (no start row
  // was ever inserted) so denied dispatcher calls remain observable.
  const recordPolicyDenied = (conn: ProviderConnection | undefined, target: ModelTarget): void => {
    if (!telemetryTask) return;
    insertTerminalAiModelCall({
      workspaceId: telemetryWorkspaceId,
      task: telemetryTask,
      provider: target.connectionId,
      model: target.modelId,
      locality: conn ? localityOf(conn) : 'cloud',
      status: 'policy_denied',
      errorCode: 'policy_denied',
    });
  };

  // 1. Resolve Primary Connection
  const primaryConn = config.connections[primary.connectionId];
  if (!primaryConn || !primaryConn.enabled) {
    recordPolicyDenied(primaryConn, primary);
    throw new AiPolicyDeniedError(
      `Primary connection "${primary.connectionId}" for workload "${workload}" is not configured or disabled.`,
      primary.connectionId,
      primary.modelId,
    );
  }

  // 1b. Capability gate: chat/naming/tool/vision workloads require a
  // chat-capable connection. System One (typed-judgment) connections are
  // rejected here — never dispatched to /chat/completions.
  if (isSystemOneConnection(primaryConn)) {
    recordPolicyDenied(primaryConn, primary);
    throw new AiPolicyDeniedError(
      `Primary connection "${primaryConn.label}" is a typed-judgment (System One) connection and cannot serve ` +
        `the "${workload}" workload, which requires chat completion.`,
      primary.connectionId,
      primary.modelId,
    );
  }
  // 2. Validate Data Sharing Policy for Primary
  const textAllowed = isTargetPermittedByPolicy(primaryConn.trustZone, textDataSharing);
  if (!textAllowed) {
    recordPolicyDenied(primaryConn, primary);
    throw new AiPolicyDeniedError(
      `Text data sharing policy "${textDataSharing}" forbids transmission to ${primaryConn.trustZone} connection "${primaryConn.label}".`,
      primary.connectionId,
      primary.modelId,
    );
  }

  if (requiresImage) {
    const imageAllowed = isTargetPermittedByPolicy(primaryConn.trustZone, imageDataSharing);
    if (!imageAllowed) {
      recordPolicyDenied(primaryConn, primary);
      throw new AiPolicyDeniedError(
        `Image data sharing policy "${imageDataSharing}" forbids image transmission to ${primaryConn.trustZone} connection "${primaryConn.label}".`,
        primary.connectionId,
        primary.modelId,
      );
    }
  }

  // 3. Attempt Primary Execution
  let misconfigurationWarning: string | undefined;
  let primaryCallId: string | null = null;

  try {
    // Record the primary attempt BEFORE the fast reachability check so a
    // LAN fast-fail still leaves a durable telemetry row for the attempt.
    if (telemetryTask) {
      primaryCallId = insertAiModelCallStart({
        workspaceId: telemetryWorkspaceId,
        task: telemetryTask,
        provider: primaryConn.id,
        model: primary.modelId,
        locality: localityOf(primaryConn),
      });
    }
    const primaryStartedAt = Date.now();

    // Fast LAN reachability check: ONLY a cached or freshly probed
    // 'unreachable' state fast-fails to fallback. A cached 'misconfigured'
    // state is NEVER converted into an availability failure (that would
    // permit fallback on a policy/misconfiguration problem) — the transport
    // re-validates instead: trust-zone/pinning violations throw
    // `AiPolicyDeniedError` (no fallback), while auth/model issues throw
    // `AiMisconfigurationError` (fallback with a visible warning).
    if (primaryConn.trustZone === 'trusted_lan') {
      const cachedHealth = getCachedConnectionHealth(primaryConn.id);
      if (cachedHealth === 'unreachable') {
        throw new AiAvailabilityError(
          `Primary LAN host "${primaryConn.label}" is cached unreachable/offline.`,
          primaryConn.id,
          primary.modelId,
        );
      }
      if (cachedHealth === null) {
        const probe = await probeConnectionHealth(primaryConn, false);
        if (probe.status === 'unreachable') {
          throw new AiAvailabilityError(
            `Primary LAN host "${primaryConn.label}" is unreachable (${probe.errorMessage || 'connect probe timeout'}).`,
            primaryConn.id,
            primary.modelId,
          );
        }
      }
    }

    const res = await executeOpenAiChat(primaryConn, primary.modelId, messages, options);
    if (primaryCallId) {
      const locality = localityOf(primaryConn);
      const cost = computeApiCost(
        primaryConn.id,
        primary.modelId,
        locality,
        res.usage?.promptTokens ?? null,
        res.usage?.completionTokens ?? null,
      );
      terminalize(primaryCallId, {
        status: 'success',
        durationMs: Date.now() - primaryStartedAt,
        promptTokens: res.usage?.promptTokens ?? null,
        completionTokens: res.usage?.completionTokens ?? null,
        estimatedApiCostUsd: cost.estimatedApiCostUsd,
        costBasis: cost.costBasis,
      });
    }
    return {
      ...res,
      executedTarget: primary,
      wasFallback: false,
    };
  } catch (err: any) {
    // Policy denials MUST NEVER fallback (fail closed)
    if (err instanceof AiPolicyDeniedError || err?.isPolicyDenial) {
      if (primaryCallId) {
        terminalize(primaryCallId, {
          status: 'policy_denied',
          errorCode: err.name ?? 'policy_denied',
          costBasis: localityOf(primaryConn) === 'local' ? 'local_zero' : 'unknown',
        });
      }
      throw err;
    }

    const isAvailability = err instanceof AiAvailabilityError || err?.isAvailabilityFailure;
    const isMisconfig = err instanceof AiMisconfigurationError || err?.isMisconfiguration;

    if (!isAvailability && !isMisconfig) {
      // Unknown non-transport error: rethrow (terminalize the started row so
      // it is never stranded).
      if (primaryCallId) {
        terminalize(primaryCallId, {
          status: 'failed',
          errorCode: err?.name ?? 'UNKNOWN',
          costBasis: localityOf(primaryConn) === 'local' ? 'local_zero' : 'unknown',
        });
      }
      throw err;
    }

    // Issue #333 cause precision: remember the primary failure's HTTP status
    // at this boundary (before any fallback executes) so callers can tell a
    // primary 429 (quota → alert) from a primary timeout/503 (no quota pin).
    const primaryStatusCode =
      typeof err?.statusCode === 'number'
        ? (err.statusCode as number)
        : /HTTP 429\b/.test(err instanceof Error ? err.message : String(err?.message ?? '')) ? 429 : undefined;
    if (primaryCallId) {
      terminalize(primaryCallId, {
        status: 'failed',
        errorCode: err?.name ?? (isMisconfig ? 'MISCONFIGURED' : 'UNAVAILABLE'),
        costBasis: localityOf(primaryConn) === 'local' ? 'local_zero' : 'unknown',
      });
    }

    if (isMisconfig) {
      misconfigurationWarning = `Primary model "${primary.modelId}" misconfigured on "${primaryConn.label}": ${err.message}`;
      console.warn(`[InferenceDispatcher] ${misconfigurationWarning}`);
    } else {
      console.warn(
        `[InferenceDispatcher] Primary target ${primary.connectionId}:${primary.modelId} unavailable: ${err.message}. Attempting fallback...`,
      );
    }

    // 4. Evaluate Fallback Target
    if (!fallback) {
      if (terminalBehavior === 'fail_closed') {
        const failedClosed = new Error(
          `Workload "${workload}" failed closed: primary target failed and no fallback is configured (${err.message}).`,
          { cause: err },
        );
        (failedClosed as Error & { primaryStatusCode?: number }).primaryStatusCode = primaryStatusCode;
        throw failedClosed;
      }
      throw err;
    }

    const fallbackConn = config.connections[fallback.connectionId];
    if (!fallbackConn || !fallbackConn.enabled) {
      const rejection = new Error(
        `Fallback connection "${fallback.connectionId}" for workload "${workload}" is not configured or disabled.`,
        { cause: err },
      );
      (rejection as Error & { primaryStatusCode?: number }).primaryStatusCode = primaryStatusCode;
      throw rejection;
    }
    // Issue #333 P2: a rejected fallback must not lose the primary failure.
    // Chain it as `cause` and tag the primary status (always set — presence
    // is the signal) so the quota boundary pins on the PRIMARY 429 and the
    // rethrow still surfaces why the fallback refused.
    if (isSystemOneConnection(fallbackConn)) {
      const rejection = new AiPolicyDeniedError(
        `Cannot fallback to "${fallbackConn.label}": typed-judgment (System One) connections cannot serve ` +
          `the "${workload}" workload, which requires chat completion.`,
        fallback.connectionId,
        fallback.modelId,
      );
      (rejection as Error & { cause?: unknown }).cause = err;
      (rejection as Error & { primaryStatusCode?: number }).primaryStatusCode = primaryStatusCode;
      throw rejection;
    }

    // Validate Data Sharing Policy for Fallback
    const fbTextAllowed = isTargetPermittedByPolicy(fallbackConn.trustZone, textDataSharing);
    if (!fbTextAllowed) {
      const rejection = new AiPolicyDeniedError(
        `Cannot fallback to "${fallbackConn.label}": Text data sharing policy "${textDataSharing}" forbids transmission to ${fallbackConn.trustZone}.`,
        fallback.connectionId,
        fallback.modelId,
      );
      (rejection as Error & { cause?: unknown }).cause = err;
      (rejection as Error & { primaryStatusCode?: number }).primaryStatusCode = primaryStatusCode;
      throw rejection;
    }

    if (requiresImage) {
      const fbImageAllowed = isTargetPermittedByPolicy(fallbackConn.trustZone, imageDataSharing);
      if (!fbImageAllowed) {
        const rejection = new AiPolicyDeniedError(
          `Cannot fallback to "${fallbackConn.label}": Image data sharing policy "${imageDataSharing}" forbids transmission to ${fallbackConn.trustZone}.`,
          fallback.connectionId,
          fallback.modelId,
        );
        (rejection as Error & { cause?: unknown }).cause = err;
        (rejection as Error & { primaryStatusCode?: number }).primaryStatusCode = primaryStatusCode;
        throw rejection;
      }
    }

    // 5. Execute Fallback
    const fbCallId = telemetryTask
      ? insertAiModelCallStart({
          workspaceId: telemetryWorkspaceId,
          task: telemetryTask,
          provider: fallbackConn.id,
          model: fallback.modelId,
          locality: localityOf(fallbackConn),
          fallbackFromCallId: primaryCallId ?? undefined,
          retryCount: 1,
        })
      : null;
    const fbStartedAt = Date.now();
    let fbRes;
    try {
      fbRes = await executeOpenAiChat(fallbackConn, fallback.modelId, messages, options);
    } catch (fbErr: unknown) {
      if (fbCallId) {
        terminalize(fbCallId, {
          status: 'failed',
          errorCode: fbErr instanceof Error ? fbErr.name : 'FALLBACK_FAILED',
          costBasis: localityOf(fallbackConn) === 'local' ? 'local_zero' : 'unknown',
        });
      }
      // Preserve the primary failure through fallback execution: a primary
      // 429 + fallback 503 must still surface the 429 to the caller (the
      // dispatcher throws only fbErr, losing the primary error — issue #333
      // P2). Chain the primary error as `cause` and ALWAYS tag the primary
      // status (even undefined): the tag's PRESENCE tells callers the outer
      // error is the fallback's, so a fallback 429 after a primary timeout
      // can never read as primary quota.
      if (fbErr instanceof Error) {
        (fbErr as Error & { cause?: unknown }).cause = err;
        (fbErr as Error & { primaryStatusCode?: number }).primaryStatusCode = primaryStatusCode;
      }
      throw fbErr;
    }
    if (fbCallId) {
      const fbLocality = localityOf(fallbackConn);
      const cost = computeApiCost(
        fallbackConn.id,
        fallback.modelId,
        fbLocality,
        fbRes.usage?.promptTokens ?? null,
        fbRes.usage?.completionTokens ?? null,
      );
      terminalize(fbCallId, {
        status: 'success',
        durationMs: Date.now() - fbStartedAt,
        promptTokens: fbRes.usage?.promptTokens ?? null,
        completionTokens: fbRes.usage?.completionTokens ?? null,
        estimatedApiCostUsd: cost.estimatedApiCostUsd,
        costBasis: cost.costBasis,
      });
    }
    return {
      ...fbRes,
      executedTarget: fallback,
      wasFallback: true,
      warning: misconfigurationWarning,
      ...(primaryStatusCode !== undefined ? { primaryStatusCode } : {}),
    };
  }
}
