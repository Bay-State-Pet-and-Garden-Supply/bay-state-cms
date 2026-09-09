/**
 * Provider-agnostic LLM Client for Onboarding Pipeline.
 *
 * Two layers of configuration:
 *
 * 1. **Provider credentials** in `api_keys` (`deepseek`, `openai`,
 *    `ollama`): hold the actual API key and base URL.
 *
 * 2. **Task routing** in `llm_task_configs`: maps each AI task
 *    (`profile_generation`, `product_name_consolidation`,
 *    `discovery_candidate_selection`, etc.) to a
 *    provider and model. Provider credentials are looked up from
 *    `api_keys` after the task config resolves the provider.
 *
 * Profile tasks (`profile_generation`, `profile_revision`) require an
 * explicit `llm_task_configs` row — they fail closed if no config is
 * found so a missing config never silently falls back to a model the
 * operator did not pick. Other tasks (`product_name_consolidation`,
 * `product_curation`, `category_classification`,
 * `classification_evidence_extraction`) allow fallback to the generic
 * `getLlmConfig()` so existing call paths keep working.
 *
 * The original `getLlmConfig()` / `callLlm()` functions are kept as
 * the generic fallback and are used by the consolidation/curation
 * paths. New code should prefer `getLlmConfigForTask()` and
 * `callLlmForTask()`.
 */

import { getApiKey } from '../db/repositories/api-key-repo';
import { getFullAiRoutingConfig, isAiComputeConfigured } from '../db/repositories/provider-connection-repo';
import { dispatchWorkloadChat } from '../ai/inference-dispatcher';
import { AiPolicyDeniedError } from '../ai/network-transport';
import { isConnectionUsable, type ProviderConnection, type ModelTarget } from '../ai/provider-connections';
import {
  getLlmTaskConfig,
  type LlmProvider,
  type LlmTask,
  type LlmTaskConfig,
} from '../db/repositories/llm-task-config-repo';
import { extractConsensusName } from './lcs-extractor';
import {
  ModelPolicyDeniedError,
  resolveModelRoute,
  assertModelPolicyIntact,
  redactIdentifier,
  redactTransportText,
  type ModelPolicyView,
  type ProtectedOperation,
} from '../classification/model-policy-gateway';
import {
  computePromptHashes,
  MODEL_CALL_STATUS,
  COST_BASIS,
  OPERATION_PARAMETERS,
  type ModelCallContext,
} from '../classification/model-operation-registry';
import { assertModelPlanCompatible, type RuntimeClassificationSnapshot } from '../classification/runtime-snapshot';
import { HeartbeatLostError } from '../classification/heartbeat-errors';
import {
  insertModelCallStart,
  completeModelCall,
  insertTerminalModelCall,
  computeModelCallCost,
} from '../db/repositories/classification-model-call-repo';
import {
  insertAiModelCallStart,
  completeAiModelCall as completeAiModelCallGeneral,
} from '../db/repositories/ai-model-call-repo';
import { computeApiCost } from '../ai/model-pricing';

import { acquireLocalSlot as acquireLlmSlot, releaseLocalSlot as releaseLlmSlot } from '../ai/local-runtime-coordinator';

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** Default base URLs when a provider credential has none configured. */
const DEFAULT_BASE_URLS: Record<LlmProvider, string> = {
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
  ollama: 'http://localhost:11434/v1',
};

/** Default model names when a credential/model config has none set. */
const DEFAULT_MODELS: Record<LlmProvider, string> = {
  deepseek: 'deepseek-v4-flash',
  openai: 'gpt-4o-mini',
  ollama: 'llama3',
};

/**
 * Thrown when a profile task is requested but no `llm_task_configs`
 * row exists and `allowFallback` is false. Distinct error class so
 * callers (e.g. the page extractor) can map this to a `failed` audit
 * row rather than a generic exception.
 */
export class MissingLlmTaskConfigError extends Error {
  constructor(public readonly task: LlmTask) {
    super(
      `No llm_task_configs row found for task "${task}". ` +
        'Profile tasks require an explicit task-specific configuration ' +
        'in Settings → AI Model Routing.',
    );
    this.name = 'MissingLlmTaskConfigError';
  }
}

/**
 * The set of tasks that fail closed when no `llm_task_configs` row
 * is present. The product decision (grill-me questions 17-19) is
 * that profile generation and revision must not silently fall back
 * to a model the operator did not pick.
 */
// fallow-ignore-next-line unused-export
export const PROFILE_TASKS_REQUIRE_EXPLICIT: ReadonlySet<LlmTask> = new Set([
  'profile_generation',
  'profile_revision',
]);

/**
 * Resolve the generic fallback config. This is the legacy priority
 * order (DeepSeek → OpenAI → Ollama) and is used when no task-
 * specific config is found AND the caller allows fallback.
 */
export function getLlmConfig(): LlmConfig | null {
  try {
    const aiConfig = getFullAiRoutingConfig();
    const target = aiConfig.defaults.catalogTarget;
    const conn = aiConfig.connections[target.connectionId];
    if (conn && isConnectionUsable(conn)) {
      const provider: LlmProvider = conn.id.includes('deepseek')
        ? 'deepseek'
        : (conn.id.includes('ollama') ? 'ollama' : 'openai');
      return {
        provider,
        apiKey: conn.credential || 'enabled',
        baseUrl: conn.baseUrl,
        model: target.modelId,
      };
    }

    // AI Compute is authoritative once configured: a configured-but-unusable
    // route fails closed here rather than silently selecting the legacy
    // api_keys chain (which would bypass the AI Compute privacy boundary).
    if (isAiComputeConfigured()) {
      return null;
    }
  } catch {
    // Database fallback
  }

  // Legacy migration path (never-configured installs only): Try DeepSeek first (recommended cloud)
  const deepseek = getApiKey('deepseek');
  if (deepseek && deepseek.api_key) {
    if (deepseek.api_key.includes('•')) {
      console.warn(
        '[LLMClient] DeepSeek API key is redacted/masked in api_keys — skipping. ' +
          'Re-enter the full key in Settings → LLM Providers.',
      );
    } else {
      return {
        provider: 'deepseek',
        apiKey: deepseek.api_key,
        baseUrl: deepseek.base_url || DEFAULT_BASE_URLS.deepseek,
        model: deepseek.model || DEFAULT_MODELS.deepseek,
      };
    }
  }

  // Try OpenAI second
  const openai = getApiKey('openai');
  if (openai && openai.api_key) {
    if (openai.api_key.includes('•')) {
      console.warn(
        '[LLMClient] OpenAI API key is redacted/masked in api_keys — skipping. ' +
          'Re-enter the full key in Settings → LLM Providers.',
      );
    } else {
      return {
        provider: 'openai',
        apiKey: openai.api_key,
        baseUrl: openai.base_url || DEFAULT_BASE_URLS.openai,
        model: openai.model || DEFAULT_MODELS.openai,
      };
    }
  }

  // Try Ollama third (local)
  const ollama = getApiKey('ollama');
  if (ollama && ollama.api_key) {
    if (ollama.api_key.includes('•')) {
      console.warn(
        '[LLMClient] Ollama API key is redacted/masked in api_keys — skipping. ' +
          'Re-enter the full key in Settings → LLM Providers.',
      );
    } else {
      return {
        provider: 'ollama',
        apiKey: ollama.api_key || 'ollama-default',
        baseUrl: ollama.base_url || DEFAULT_BASE_URLS.ollama,
        model: ollama.model || DEFAULT_MODELS.ollama,
      };
    }
  }

  return null;
}

/**
 * Resolve the provider credential row from `api_keys` for the given
 * provider. Returns `null` if the provider is unconfigured or the
 * stored key is a masked placeholder. Logs a warning in the
 * masked-key case so operators can spot the misconfiguration in
 * server logs.
 */
function resolveProviderCredential(
  provider: LlmProvider,
): { apiKey: string; baseUrl: string | null; model: string | null } | null {
  const row = getApiKey(provider);
  if (!row || !row.api_key) {
    console.warn(`[LLMClient] No API key configured for provider "${provider}" in Settings → LLM Providers.`);
    return null;
  }
  if (row.api_key.includes('•')) {
    console.warn(
      `[LLMClient] Provider "${provider}" has a redacted/masked API key in api_keys ` +
        `(value contains '•'). Re-enter the full key in Settings → LLM Providers.`,
    );
    return null;
  }
  return {
    apiKey: row.api_key,
    baseUrl: row.base_url,
    model: row.model,
  };
}

/**
 * Build an `LlmConfig` from a task config + matching provider
 * credential. Returns `null` if the provider credential is missing.
 */
function buildConfigFromTaskConfig(
  taskConfig: LlmTaskConfig,
): LlmConfig | null {
  const cred = resolveProviderCredential(taskConfig.provider);
  if (!cred) return null;
  return {
    provider: taskConfig.provider,
    apiKey: cred.apiKey,
    baseUrl: taskConfig.baseUrlOverride || cred.baseUrl || DEFAULT_BASE_URLS[taskConfig.provider],
    model: taskConfig.model,
  };
}

export interface GetLlmConfigForTaskOptions {
  /**
   * When `true` and no task-specific config is found, fall back to
   * the generic `getLlmConfig()`. Defaults to `true` for non-profile
   * tasks and `false` for profile tasks. Pass an explicit value to
   * override the per-task default.
   *
   * IGNORED for protected classification operations when `modelPolicy`
   * is provided: protected calls never use the generic fallback chain.
   */
  allowFallback?: boolean;
  /**
   * Frozen classification model-policy view (issue #17 item A).
   * - A view: route selection uses the policy (stage override or default),
   *   locality/endpoint checks, and the explicit paired fallback only.
   * - `null` (explicit disabled): protected calls resolve to no config
   *   (deterministic fallback, no transport).
   * - `undefined` with a protected task: denied (policy_absent) — every
   *   protected call site must thread an explicit policy context.
   */
  modelPolicy?: ModelPolicyView | null;
  /** Protected operation for policy routing; defaults from the task name. */
  protectedOperation?: ProtectedOperation;
  /**
   * Whether the call is image-bearing (vision). When true, the image
   * data-sharing policy is enforced during route resolution (issue #17
   * pass 1c): an image never leaves the machine under
   * `imageDataSharing: 'local_only'` unless the provider is declared local.
   */
  requiresImage?: boolean;
}

/**
 * The default protected operation for a task, or `null` when the task is not
 * a classification/onboarding protected operation.
 */
export function defaultProtectedOperationForTask(task: LlmTask): ProtectedOperation | null {
  switch (task) {
    case 'classification_evidence_extraction':
      return 'evidence_extraction';
    case 'product_type_classification':
      return 'product_type_ranking';
    case 'attribute_value_classification':
      return 'attribute_ranking';
    case 'category_page_assignment':
      return 'page_assignment';
    case 'product_name_consolidation':
      return 'discovery_name_consolidation';
    case 'discovery_candidate_selection':
      return 'sitemap_selection';
    // Policy-governed task names: both are governed by the workspace
    // classification model policy. Mapping them here means omitting
    // `modelPolicy` fails closed (policy_absent) instead of falling through
    // to the legacy DeepSeek → OpenAI → Ollama chain (issue #17 pass 1c).
    case 'product_curation':
      return 'title_consolidation';
    case 'category_classification':
      return 'cohort_page_assignment';
    default:
      return null;
  }
}

function credentialForProvider(provider: string): {
  provider: string;
  apiKey: string;
  baseUrl: string | null;
  model: string | null;
} | null {
  // AI Compute connection bridge: a provider string that names an enabled,
  // usable ProviderConnection resolves its credential/base URL from AI
  // Compute — frozen protected runs can target a connection (e.g. a
  // trusted-LAN LM Studio box) without a parallel `api_keys` entry. The
  // connection's trust zone is enforced by `resolveModelRoute`'s
  // locality/endpoint checks; the policy remains the routing authority.
  try {
    const aiConfig = getFullAiRoutingConfig();
    const conn = aiConfig.connections[provider];
    if (conn && isConnectionUsable(conn)) {
      return { provider, apiKey: conn.credential || 'enabled', baseUrl: conn.baseUrl, model: null };
    }
  } catch {
    // DB unavailable → legacy lookup below
  }
  if (provider !== 'deepseek' && provider !== 'openai' && provider !== 'ollama') {
    // Unknown providers have no credential store; fail closed upstream via
    // locality_undeclared unless the caller resolves them explicitly.
    return null;
  }
  const cred = resolveProviderCredential(provider);
  return cred ? { provider, ...cred } : null;
}

/**
 * Resolve a protected call through the frozen model policy. Throws
 * `ModelPolicyDeniedError` on any policy/endpoint/credential denial.
 */
function resolveProtectedConfig(
  task: LlmTask,
  operation: ProtectedOperation,
  view: ModelPolicyView,
  requiresImage = false,
): LlmConfig {
  const route = resolveModelRoute(view, operation, {
    getCredential: (p: string) => {
      const c = credentialForProvider(p as LlmProvider);
      return c ? { provider: p, apiKey: c.apiKey, baseUrl: c.baseUrl ?? null, model: c.model ?? null } : null;
    },
    defaultBaseUrls: DEFAULT_BASE_URLS as unknown as Readonly<Record<string, string>>,
  }, requiresImage);
  return {
    provider: route.provider as LlmProvider,
    apiKey: route.apiKey,
    baseUrl: route.baseUrl,
    model: route.model,
  };
}

/**
 * Re-assert the frozen policy IMMEDIATELY before transport (issue #17 pass
 * 1b): re-checks policy integrity AND re-resolves the protected route,
 * failing closed when the route/locality changed after the queue wait or
 * when the policy was tampered with. Only the explicit paired fallback may
 * ever be selected; implicit generic fallback is impossible.
 */
function reassertProtectedRouteBeforeTransport(
  task: LlmTask,
  config: LlmConfig,
  options: { modelPolicy?: ModelPolicyView | null; protectedOperation?: ProtectedOperation; requiresImage?: boolean },
): void {
  const view = options.modelPolicy;
  if (!view) return;
  const operation = options.protectedOperation ?? defaultProtectedOperationForTask(task);
  if (!operation) return;
  // Digest + deep-frozen view tamper check.
  assertModelPolicyIntact(view);
  // Re-resolve the route and compare against the config about to be used.
  const fresh = resolveProtectedConfig(task, operation, view, options.requiresImage === true);
  if (
    fresh.provider !== config.provider ||
    fresh.model !== config.model ||
    fresh.baseUrl !== config.baseUrl
  ) {
    throw new ModelPolicyDeniedError('policy_tampered', operation, fresh.provider);
  }
}

/**
 * Resolve the LLM config for a specific AI task.
 *
 * Protected classification operations resolve exclusively through the frozen
 * model policy (`modelPolicy`), never through `llm_task_configs` or the
 * generic DeepSeek → OpenAI → Ollama fallback. Non-protected tasks keep the
 * legacy resolution order unchanged.
 *
 * @throws {MissingLlmTaskConfigError} When a profile task is requested with
 *   no task config and no fallback.
 * @throws {ModelPolicyDeniedError} When a protected task is called without an
 *   explicit policy view (policy_absent) or the policy denies the route.
 */
export function getLlmConfigForTask(
  task: LlmTask,
  options: GetLlmConfigForTaskOptions = {},
): LlmConfig | null {
  const operation = options.protectedOperation ?? defaultProtectedOperationForTask(task);

  // Protected operations REQUIRE an explicit policy context: omitting
  // `modelPolicy` fails closed (policy_absent) — never the AI Compute or
  // legacy chain (issue #17 pass 1c). Only an explicit frozen view (or an
  // explicit null = disabled) may route a protected call.
  if (options.modelPolicy === undefined && operation !== null) {
    throw new ModelPolicyDeniedError('policy_absent', operation);
  }

  // If this is an explicit run-bound call with a frozen policy snapshot:
  if (options.modelPolicy !== undefined) {
    if (options.modelPolicy === null) {
      // Explicit disabled policy: deterministic fallback, no transport.
      return null;
    }
    if (operation !== null) {
      return resolveProtectedConfig(task, operation, options.modelPolicy, options.requiresImage === true);
    }
  }

  // Non-run live calls or tasks without explicit frozen modelPolicy: check AI Compute configuration first!
  try {
    const aiConfig = getFullAiRoutingConfig();
    const workloadKey: keyof typeof aiConfig.workloads = workloadKeyForTask(task);

    const route = aiConfig.workloads[workloadKey];
    const target = route.primary === 'inherit' ? aiConfig.defaults.catalogTarget : route.primary;
    const conn = aiConfig.connections[target.connectionId];
    if (conn && isConnectionUsable(conn)) {
      const provider: LlmProvider = conn.id.includes('deepseek')
        ? 'deepseek'
        : (conn.id.includes('ollama') ? 'ollama' : 'openai');
      return {
        provider,
        apiKey: conn.credential || 'enabled',
        baseUrl: conn.baseUrl,
        model: target.modelId,
      };
    }

    // AI Compute is authoritative once configured: a configured-but-unusable
    // route must NOT leak into the legacy `llm_task_configs` / generic chain
    // (which would bypass the AI Compute privacy boundary). Legacy resolution
    // below is a migration path for never-configured installs only.
    if (isAiComputeConfigured()) {
      return null;
    }
  } catch {
    // Continue to legacy task config check
  }

  // Legacy migration path (never-configured installs only):
  const taskConfig = getLlmTaskConfig(task);
  if (taskConfig) {
    const built = buildConfigFromTaskConfig(taskConfig);
    if (built) return built;
  }

  const requiresExplicit = PROFILE_TASKS_REQUIRE_EXPLICIT.has(task);
  const allowFallback =
    options.allowFallback !== undefined
      ? options.allowFallback
      : !requiresExplicit;

  if (allowFallback) {
    return getLlmConfig();
  }

  if (requiresExplicit) {
    throw new MissingLlmTaskConfigError(task);
  }
  return null;
}

export interface CallLlmForTaskOptions {
  /** Override the default fallback policy for this task. */
  allowFallback?: boolean;
  /** Optional temperature override (uses the task config's temperature when set). */
  temperature?: number;
  /** Whether the call is image-bearing (vision); enforces image data-sharing policy. */
  requiresImage?: boolean;
  /** Frozen classification model-policy view (see GetLlmConfigForTaskOptions). */
  modelPolicy?: ModelPolicyView | null;
  /** Protected operation for policy routing; defaults from the task name. */
  protectedOperation?: ProtectedOperation;
  /**
   * Durable model-call audit context (issue #17 work item E). When present,
   * the wrapper inserts a `started` row before transport and updates a
   * terminal row on every path; the model output is returned only after the
   * terminal row is durable. `snapshot` is required for the plan-compatibility
   * check (a new call from a snapshot without a compatible plan fails closed).
   */
  modelCall?: ModelCallContext;
  /** Immutable runtime snapshot the call is bound to (plan compatibility). */
  snapshot?: RuntimeClassificationSnapshot | null;
  /**
   * Optional ownership assertion injected by lease-scoped callers (cohort
   * freeze executor, PR4 P1-1). When present, audited calls re-assert caller
   * ownership before run-scoped audit writes: IMMEDIATELY BEFORE the
   * `started` model-call row is inserted and immediately before EVERY
   * terminal `classification_model_calls` update. A rejected assertion (the
   * cohort run's claim was lost to a reclaiming sibling) throws
   * `HeartbeatLostError` and the call aborts with NO durable audit write —
   * the started row is never created, and an in-flight started row is never
   * terminalized (it remains a crash-equivalent abandoned row). Absent in
   * legacy/non-cohort invocations — zero behavior change.
   */
  assertHeld?: () => void;
  /** Workspace ID for general telemetry logging (defaults to 'default'). */
  workspaceId?: string;
}

/** Result of an audited model call (issue #17 work item E). */
export interface ModelCallResult {
  content: string;
  callId: string;
  provider: string;
  model: string;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  };
}

/**
 * Resolve the task's temperature override (if any). Caller-provided
 * options.temperature wins over the task config's stored value.
 */
function resolveTemperature(task: LlmTask, options: CallLlmForTaskOptions): number {
  if (options.temperature !== undefined) return options.temperature;
  try {
    const taskConfig = getLlmTaskConfig(task);
    return taskConfig?.temperature !== null && taskConfig?.temperature !== undefined
      ? taskConfig.temperature
      : 0.1;
  } catch {
    return 0.1;
  }
}

function resolveReasoningEffort(task: LlmTask): string | null {
  try {
    return getLlmTaskConfig(task)?.reasoningEffort ?? null;
  } catch {
    return null;
  }
}

/**
 * Map a live (non-protected) task to its AI Compute workload key.
 *
 * Protected tasks never reach this helper from the live path — they fail
 * closed with `policy_absent` before routing is considered.
 */
function workloadKeyForTask(task: LlmTask): 'discovery' | 'curation' | 'profileBuilder' | 'storeManager' {
  if (task.startsWith('profile_')) {
    return 'profileBuilder';
  }
  if (task === 'product_curation' || task === 'category_classification') {
    return 'curation';
  }
  if (task === 'store_manager_assistant' || task === 'product_field_refactor') {
    return 'storeManager';
  }
  return 'discovery';
}

/**
 * Resolve the AI Compute dispatch target for a live task.
 *
 * - AI Compute CONFIGURED (isAiComputeConfigured()): returns the resolved
 *   route target unconditionally — the InferenceDispatcher enforces
 *   usability, fails closed with `policy_denied` telemetry when the primary
 *   is disabled/misconfigured, and applies the route's configured fallback
 *   and terminal behavior. The legacy chain is never consulted.
 * - NOT configured (pristine install): returns the target only when the
 *   primary connection is usable, so callers fall back to the legacy
 *   `llm_task_configs` / `api_keys` chain (migration path only).
 */
function resolveLiveDispatchTarget(task: LlmTask): {
  workloadKey: ReturnType<typeof workloadKeyForTask>;
  target: ModelTarget;
} | null {
  try {
    const aiConfig = getFullAiRoutingConfig();
    const workloadKey = workloadKeyForTask(task);
    const route = aiConfig.workloads[workloadKey];
    const target = route.primary === 'inherit' ? aiConfig.defaults.catalogTarget : route.primary;
    if (isAiComputeConfigured()) {
      return { workloadKey, target };
    }
    const conn = aiConfig.connections[target.connectionId];
    if (conn && isConnectionUsable(conn)) {
      return { workloadKey, target };
    }
  } catch {
    // DB unavailable → legacy chain
  }
  return null;
}

/**
 * Perform the audited transport for one protected call. The audit context is
 * REQUIRED: without `modelCall`, this throws (callers must use the plain
 * `callLlmForTask` path for non-audited calls).
 */
async function callLlmForTaskAudited(
  task: LlmTask,
  prompt: string,
  systemPrompt: string,
  options: CallLlmForTaskOptions,
): Promise<ModelCallResult | null> {
  const ctx = options.modelCall;
  if (!ctx) {
    throw new Error('callLlmForTaskAudited requires a modelCall audit context.');
  }

  // Fail closed when the run snapshot has no compatible frozen plan for this
  // operation (legacy schema-v1 snapshot, missing entry, version drift, or a
  // forged call context). The supplied context versions are validated against
  // the frozen plan entry.
  assertModelPlanCompatible(options.snapshot, ctx.operation, ctx);

  const { systemPromptHash, userPromptHash } = computePromptHashes(systemPrompt, prompt);
  // Locality is provider-scoped; unknown before config resolution (denials
  // and unavailable states record null locality + unknown cost basis).
  const locality: string | null = null;

  let config: LlmConfig | null;
  try {
    config = getLlmConfigForTask(task, {
      allowFallback: options.allowFallback,
      modelPolicy: options.modelPolicy,
      protectedOperation: options.protectedOperation,
      requiresImage: options.requiresImage,
    });
  } catch (err) {
    if (err instanceof ModelPolicyDeniedError) {
      // PR4 P1-1 seam: a stale owner must not write even a pre-transport
      // terminal row after the claim moved. A rejected assertion throws
      // `HeartbeatLostError` and aborts before the denial row is written.
      options.assertHeld?.();
      // Record the denial as a durable terminal row (no transport happened).
      insertTerminalModelCall({
        runId: ctx.runId,
        stageName: ctx.stage,
        operation: ctx.operation,
        attempt: ctx.attempt,
        provider: null,
        model: null,
        locality,
        snapshotHash: ctx.snapshotHash,
        modelPolicyDigest: options.modelPolicy?.policyDigest ?? '',
        promptTemplateVersion: ctx.promptTemplateVersion,
        ruleVersion: ctx.ruleVersion,
        systemPromptHash,
        userPromptHash,
        status: MODEL_CALL_STATUS.policyDenied,
        errorMessage: `Model policy denied (${err.code})`,
        costBasis: COST_BASIS.unknown,
      });
    }
    throw err;
  }
  if (!config) {
    // PR4 P1-1 seam: a stale owner must not write even a pre-transport
    // terminal row after the claim moved. A rejected assertion throws
    // `HeartbeatLostError` and aborts (never a silent null for a lost
    // owner).
    options.assertHeld?.();
    // No model available (disabled policy or no credential): durable
    // `unavailable` row so the attempted call is observable.
    insertTerminalModelCall({
      runId: ctx.runId,
      stageName: ctx.stage,
      operation: ctx.operation,
      attempt: ctx.attempt,
      provider: null,
      model: null,
      locality,
      snapshotHash: ctx.snapshotHash,
      modelPolicyDigest: options.modelPolicy?.policyDigest ?? '',
      promptTemplateVersion: ctx.promptTemplateVersion,
      ruleVersion: ctx.ruleVersion,
      systemPromptHash,
      userPromptHash,
      status: MODEL_CALL_STATUS.unavailable,
      errorMessage: 'No LLM config available for the protected operation.',
      costBasis: COST_BASIS.unknown,
    });
    return null;
  }

  const resolvedLocality = options.modelPolicy?.providerLocalities[config.provider] ?? locality;

  // Re-assert the frozen policy immediately before transport (issue #17 item
  // A): validation at activation alone is insufficient.
  if (options.modelPolicy) {
    assertModelPolicyIntact(options.modelPolicy);
  }

  // PR4 P1-1 seam: re-assert caller ownership immediately before the durable
  // `started` row — ownership lost while the caller was queued prevents the
  // started row entirely (a stale owner never begins new audit provenance).
  // A rejected assertion throws `HeartbeatLostError` and propagates.
  options.assertHeld?.();

  // Insert the `started` audit row BEFORE transport. A failed start insert
  // MUST abort the call with a thrown error (never a silent null): without a
  // durable start row there is no provenance, and transport must not happen.
  const callId = insertModelCallStart({
    runId: ctx.runId,
    stageName: ctx.stage,
    operation: ctx.operation,
    attempt: ctx.attempt,
    provider: config.provider,
    model: config.model,
    locality: resolvedLocality,
    snapshotHash: ctx.snapshotHash,
    modelPolicyDigest: options.modelPolicy?.policyDigest ?? '',
    promptTemplateVersion: ctx.promptTemplateVersion,
    ruleVersion: ctx.ruleVersion,
    systemPromptHash,
    userPromptHash,
  });

  const startedAt = Date.now();
  const timeoutMs = config.provider === 'ollama' ? 120_000 : 60_000;
  // Deterministic frozen operation parameters (issue #17 E): protected calls
  // NEVER read mutable llm_task_configs for temperature/reasoning-effort. The
  // registry's OPERATION_PARAMETERS (or an explicit caller override) is the
  // only source, so mutating task config cannot change a run's transport.
  const operationParams = OPERATION_PARAMETERS[ctx.operation];
  const temperature = options.temperature ?? operationParams?.temperature ?? 0.1;
  const reasoningEffort: string | null = null;
  const requestBody: Record<string, unknown> = {
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ],
    temperature,
  };
  if (reasoningEffort) {
    requestBody.reasoning_effort = reasoningEffort;
  }

  // Terminalization guard: any error after the start row MUST leave a durable
  // terminal row (never a stranded `started`). A dedicated flag prevents
  // double-terminalization when a path already wrote its terminal row before
  // throwing (fetch errors, non-OK responses, empty content).
  let terminalWritten = false;
  const markTerminal = (update: Parameters<typeof completeModelCall>[1]): boolean => {
    // PR4 P1-1 seam: re-assert ownership before EVERY terminal write — a
    // stale owner (lease reclaimed mid-call) must never terminalize its
    // in-flight model-call row. A rejected assertion throws
    // `HeartbeatLostError`; the row stays `started` (crash-equivalent
    // abandoned) and the error propagates. Absent assertHeld = unchanged.
    options.assertHeld?.();
    terminalWritten = true;
    return completeModelCall(callId, update);
  };

  await acquireLlmSlot(config.provider);
  try {
    // Re-assert the frozen policy immediately at the transport boundary
    // (after the queue wait): tampering or route drift denies the call.
    if (options.modelPolicy) {
      reassertProtectedRouteBeforeTransport(task, config, {
        modelPolicy: options.modelPolicy,
        protectedOperation: options.protectedOperation,
        requiresImage: options.requiresImage,
      });
    }

    let response: Response;
    try {
      response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const isAbort =
        (err as { name?: string })?.name === 'AbortError' ||
        (err as { message?: string })?.message?.includes('abort') === true;
      const terminal = isAbort ? MODEL_CALL_STATUS.cancelled : MODEL_CALL_STATUS.failed;
      markTerminal({
        status: terminal,
        durationMs: Date.now() - startedAt,
        errorMessage: redactTransportText(err instanceof Error ? err.message : String(err)),
        estimatedCostUsd: resolvedLocality === 'local' ? 0 : null,
        costBasis: resolvedLocality === 'local' ? COST_BASIS.localZero : COST_BASIS.unknown,
      });
      throw err;
    }

    if (response.status >= 300 && response.status < 400) {
      const reason = `HTTP redirect (${response.status}) forbidden on LLM connection (Anti-SSRF).`;
      markTerminal({
        status: MODEL_CALL_STATUS.policyDenied,
        durationMs: Date.now() - startedAt,
        errorMessage: reason,
        estimatedCostUsd: resolvedLocality === 'local' ? 0 : null,
        costBasis: resolvedLocality === 'local' ? COST_BASIS.localZero : COST_BASIS.unknown,
      });
      throw new Error(reason);
    }

    if (!response.ok) {
      const text = await response.text();
      const reason = `LLM API request failed (${config.provider}): ${response.status} - ${redactTransportText(text)}`;
      markTerminal({
        status: MODEL_CALL_STATUS.failed,
        durationMs: Date.now() - startedAt,
        errorMessage: reason,
        estimatedCostUsd: resolvedLocality === 'local' ? 0 : null,
        costBasis: resolvedLocality === 'local' ? COST_BASIS.localZero : COST_BASIS.unknown,
      });
      // Never embed the raw provider error body in the thrown error.
      throw new Error(reason);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      markTerminal({
        status: MODEL_CALL_STATUS.failed,
        durationMs: Date.now() - startedAt,
        errorMessage: 'LLM returned an empty response.',
        estimatedCostUsd: resolvedLocality === 'local' ? 0 : null,
        costBasis: resolvedLocality === 'local' ? COST_BASIS.localZero : COST_BASIS.unknown,
      });
      throw new Error('LLM returned an empty response.');
    }

    // Token counts come from the OpenAI-compatible usage object when present;
    // absence remains null. Cost: 0 only for explicitly local routes;
    // unknown cloud rates are null + 'unknown' (never a guessed zero).
    const promptTokens = data.usage?.prompt_tokens ?? null;
    const completionTokens = data.usage?.completion_tokens ?? null;
    const cost = computeModelCallCost(resolvedLocality, promptTokens, completionTokens);

    const terminalDurable = markTerminal({
      status: MODEL_CALL_STATUS.success,
      durationMs: Date.now() - startedAt,
      promptTokens,
      completionTokens,
      estimatedCostUsd: cost.estimatedCostUsd,
      costBasis: cost.costBasis,
    });

    // No durable terminal row means the output is discarded: the model output
    // must never reach a proposal unless its terminal row is durable.
    if (!terminalDurable) {
      console.error(`[LLMClient] Model call ${callId} terminal update failed; discarding output.`);
      return null;
    }

    return {
      content: content.trim(),
      callId,
      provider: config.provider,
      model: config.model,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: data.usage?.total_tokens ?? null,
      },
    };
  } catch (err) {
    // PR4 P1-1 seam: ownership loss is NEVER swallowed or converted into a
    // terminal/null outcome — a stale owner aborts with NO further audit
    // write (the in-flight row stays `started`, crash-equivalent abandoned)
    // and the `HeartbeatLostError` propagates to abort the stale run.
    if (err instanceof HeartbeatLostError) throw err;
    // Outer terminalization: any exception after the start row that did not
    // already write a terminal row (route re-assertion, JSON decode, etc.)
    // leaves a durable `failed` row. A stranded `started` row is impossible
    // for a still-owned call.
    if (!terminalWritten) {
      try {
        markTerminal({
          status: MODEL_CALL_STATUS.failed,
          durationMs: Date.now() - startedAt,
          errorMessage: redactTransportText(err instanceof Error ? err.message : String(err)),
          estimatedCostUsd: resolvedLocality === 'local' ? 0 : null,
          costBasis: resolvedLocality === 'local' ? COST_BASIS.localZero : COST_BASIS.unknown,
        });
      } catch (terminalErr) {
        // A stale-owner assertion inside the fallback terminalization must
        // also propagate, never be logged away.
        if (terminalErr instanceof HeartbeatLostError) throw terminalErr;
        console.error(
          `[LLMClient] Failed to terminalize model call ${callId} after error: `,
          redactTransportText(terminalErr instanceof Error ? terminalErr.message : String(terminalErr)),
        );
      }
    }
    throw err;
  } finally {
    releaseLlmSlot(config.provider);
  }
}

/**
 * Call the LLM configured for a specific AI task and return the full audited
 * result (call ID, provider, model, usage) ONLY after the terminal model-call
 * row is durable. Requires `options.modelCall` + `options.snapshot`.
 */
export async function callLlmForTaskWithProvenance(
  task: LlmTask,
  prompt: string,
  systemPrompt = 'You are a helpful product cataloging assistant.',
  options: CallLlmForTaskOptions = {},
): Promise<ModelCallResult | null> {
  return callLlmForTaskAudited(task, prompt, systemPrompt, options);
}

/**
 * Call the LLM configured for a specific AI task. Resolution matches
 * `getLlmConfigForTask()`. Throws `MissingLlmTaskConfigError` for
 * profile tasks with no config; returns `null` for other tasks when
 * no config and no fallback is available.
 *
 * When `options.modelCall` is provided, the call is audited through
 * `classification_model_calls` (started → terminal on every path) and the
 * content is returned only after the terminal row is durable.
 */
export async function callLlmForTask(
  task: LlmTask,
  prompt: string,
  systemPrompt = 'You are a helpful product cataloging assistant.',
  options: CallLlmForTaskOptions = {},
): Promise<string | null> {
  if (options.modelCall) {
    const result = await callLlmForTaskAudited(task, prompt, systemPrompt, options);
    return result?.content ?? null;
  }

  // Explicit disabled policy: deterministic fallback, NO transport. `null`
  // must never reach the live dispatcher — an explicit disable is a security
  // assertion, not an absence of context.
  if (options.modelPolicy === null) {
    return null;
  }

  // Live (non-run) calls without a policy context:
  if (options.modelPolicy === undefined) {
    const protectedOp = options.protectedOperation ?? defaultProtectedOperationForTask(task);
    if (protectedOp !== null) {
      // Protected operations fail closed without a frozen policy context
      // (policy_absent) — the legacy/AI-Compute chain is never selected.
      throw new ModelPolicyDeniedError('policy_absent', protectedOp);
    }

    // Dispatch through the InferenceDispatcher when AI Compute has a usable
    // primary route (with its configured fallbacks + data-sharing policy
    // enforcement + telemetry); otherwise fall through to the legacy
    // task-config resolution below.
    const liveTarget = resolveLiveDispatchTarget(task);
    if (liveTarget) {
      const temperature = resolveTemperature(task, options);
      const reasoningEffort = resolveReasoningEffort(task);

      try {
        const messages = [
          { role: 'system' as const, content: systemPrompt },
          { role: 'user' as const, content: prompt },
        ];
        const result = await dispatchWorkloadChat(liveTarget.workloadKey, messages, {
          temperature,
          reasoningEffort: reasoningEffort ?? undefined,
          requiresImage: options.requiresImage,
          telemetry: { workspaceId: options.workspaceId ?? 'default', task },
        });
        return result.content;
      } catch (err: any) {
        if (err instanceof AiPolicyDeniedError || err?.isPolicyDenial) {
          throw err;
        }
        throw err;
      }
    }
    // NOT configured (pristine install) and no usable route → legacy migration
    // path below. Once AI Compute is configured, resolveLiveDispatchTarget
    // always returns a target and this comment is never reached.
  }

  let config: LlmConfig | null;
  try {
    config = getLlmConfigForTask(task, {
      allowFallback: options.allowFallback,
      modelPolicy: options.modelPolicy,
      protectedOperation: options.protectedOperation,
      requiresImage: options.requiresImage,
    });
  } catch (err) {
    if (err instanceof MissingLlmTaskConfigError || err instanceof ModelPolicyDeniedError) {
      throw err;
    }
    throw err;
  }
  if (!config) return null;

  if (options.modelPolicy) {
    assertModelPolicyIntact(options.modelPolicy);
  }

  const temperature = resolveTemperature(task, options);
  const reasoningEffort = resolveReasoningEffort(task);

  const protectedOp = options.protectedOperation ?? defaultProtectedOperationForTask(task);

  // Standalone protected operation call with modelPolicy but without modelCall:
  if (protectedOp) {
    await acquireLlmSlot(config.provider);
    try {
      if (options.modelPolicy) {
        reassertProtectedRouteBeforeTransport(task, config, {
          modelPolicy: options.modelPolicy,
          protectedOperation: options.protectedOperation,
          requiresImage: options.requiresImage,
        });
      }
      const timeoutMs = config.provider === 'ollama' ? 120_000 : 60_000;
      const requestBody: Record<string, unknown> = {
        model: config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        temperature,
      };
      if (reasoningEffort) {
        requestBody.reasoning_effort = reasoningEffort;
      }
      const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.status >= 300 && response.status < 400) {
        throw new Error(`HTTP redirect (${response.status}) forbidden on LLM connection (Anti-SSRF).`);
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `LLM API request failed (${config.provider}): ${response.status} - ${redactTransportText(text)}`,
        );
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content || !content.trim()) {
        throw new Error('LLM returned an empty response.');
      }
      return content.trim();
    } finally {
      releaseLlmSlot(config.provider);
    }
  }

  const taskConfig = getLlmTaskConfig(task);
  const fallbackProvider = taskConfig?.fallbackProvider ?? null;
  const fallbackModel = taskConfig?.fallbackModel ?? null;

  const workspaceId = options.workspaceId ?? 'default';
  const locality = config.provider === 'ollama' ? 'local' : 'cloud';
  const primaryStartAt = Date.now();

  const primaryCallId = insertAiModelCallStart({
    workspaceId,
    task,
    provider: config.provider,
    model: config.model,
    locality,
  });

  const makeSingleRequest = async (cfg: LlmConfig): Promise<{ content: string; promptTokens: number | null; completionTokens: number | null }> => {
    await acquireLlmSlot(cfg.provider);
    try {
      if (options.modelPolicy) {
        reassertProtectedRouteBeforeTransport(task, cfg, {
          modelPolicy: options.modelPolicy,
          protectedOperation: options.protectedOperation,
          requiresImage: options.requiresImage,
        });
      }
      const timeoutMs = cfg.provider === 'ollama' ? 120_000 : 60_000;
      const requestBody: Record<string, unknown> = {
        model: cfg.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        temperature,
      };
      if (reasoningEffort) {
        requestBody.reasoning_effort = reasoningEffort;
      }
      const response = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `LLM API request failed (${cfg.provider}): ${response.status} - ${redactTransportText(text)}`,
        );
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content || !content.trim()) {
        throw new Error('LLM returned an empty response.');
      }
      return {
        content: content.trim(),
        promptTokens: data.usage?.prompt_tokens ?? null,
        completionTokens: data.usage?.completion_tokens ?? null,
      };
    } finally {
      releaseLlmSlot(cfg.provider);
    }
  };

  try {
    const res = await makeSingleRequest(config);
    const cost = computeApiCost(config.provider, config.model, locality, res.promptTokens, res.completionTokens);
    completeAiModelCallGeneral(primaryCallId, {
      status: 'success',
      durationMs: Date.now() - primaryStartAt,
      promptTokens: res.promptTokens,
      completionTokens: res.completionTokens,
      estimatedApiCostUsd: cost.estimatedApiCostUsd,
      costBasis: cost.costBasis,
    });
    return res.content;
  } catch (primaryErr) {
    completeAiModelCallGeneral(primaryCallId, {
      status: 'failed',
      durationMs: Date.now() - primaryStartAt,
      errorCode: primaryErr instanceof Error ? primaryErr.name : 'PRIMARY_FAILED',
      costBasis: locality === 'local' ? 'local_zero' : 'unknown',
    });

    if (fallbackProvider && fallbackModel && !options.modelPolicy) {
      const fallbackCred = resolveProviderCredential(fallbackProvider);
      if (fallbackCred) {
        const fallbackConfig: LlmConfig = {
          provider: fallbackProvider,
          apiKey: fallbackCred.apiKey,
          baseUrl: fallbackCred.baseUrl || DEFAULT_BASE_URLS[fallbackProvider],
          model: fallbackModel,
        };
        const fallbackLocality = fallbackProvider === 'ollama' ? 'local' : 'cloud';
        const fallbackStartAt = Date.now();

        const fallbackCallId = insertAiModelCallStart({
          workspaceId,
          task,
          provider: fallbackProvider,
          model: fallbackModel,
          locality: fallbackLocality,
          fallbackFromCallId: primaryCallId,
          retryCount: 1,
        });

        try {
          const fallbackRes = await makeSingleRequest(fallbackConfig);
          const cost = computeApiCost(
            fallbackConfig.provider,
            fallbackConfig.model,
            fallbackLocality,
            fallbackRes.promptTokens,
            fallbackRes.completionTokens,
          );
          completeAiModelCallGeneral(fallbackCallId, {
            status: 'success',
            durationMs: Date.now() - fallbackStartAt,
            promptTokens: fallbackRes.promptTokens,
            completionTokens: fallbackRes.completionTokens,
            estimatedApiCostUsd: cost.estimatedApiCostUsd,
            costBasis: cost.costBasis,
          });
          return fallbackRes.content;
        } catch (fallbackErr) {
          completeAiModelCallGeneral(fallbackCallId, {
            status: 'failed',
            durationMs: Date.now() - fallbackStartAt,
            errorCode: fallbackErr instanceof Error ? fallbackErr.name : 'FALLBACK_FAILED',
            costBasis: fallbackLocality === 'local' ? 'local_zero' : 'unknown',
          });
          throw fallbackErr;
        }
      }
    }

    throw primaryErr;
  }
}

/**
 * Call completion API of the active LLM provider (generic fallback).
 * Existing callers that have not yet been migrated to `callLlmForTask`
 * continue to use this. New code should prefer the task-specific
 * helper.
 */
// fallow-ignore-next-line unused-export
export async function callLlm(
  prompt: string,
  systemPrompt = 'You are a helpful product cataloging assistant.',
): Promise<string> {
  const res = await callLlmForTask('product_name_consolidation', prompt, systemPrompt, { allowFallback: true });
  if (!res) {
    throw new Error('No LLM API keys configured in settings.');
  }
  return res;
}

/**
 * Consolidate a canonical product name from search result titles and snippets.
 * Falls back to the LCS algorithm if the LLM is not configured or fails.
 *
 * Uses the `product_name_consolidation` task config when present;
 * otherwise falls back to the generic `callLlm()` / LCS path. The
 * fallback is intentional: product name consolidation is the
 * "least-stakes" AI task and a configured local Ollama should
 * continue to work even before a task-specific config has been
 * created.
 */

/**
 * Extract protected size/weight/count/volume tokens from a raw product name.
 * These are identity-bearing details that must survive expected name generation
 * (brand, size, flavor, variant, count, weight, etc.).
 *
 * Canonical definitions live in title-prompt-template (issue #111) so the
 * deterministic title post-steps share one tokenizer; re-exported here so
 * existing importers (discovery consolidation, guard tests) are unaffected.
 *
 * Exported for testing.
 */
// fallow-ignore-next-line unused-export — used by tests
import { extractProtectedTokens, normalizeProtectedToken } from './title-prompt-template';
// fallow-ignore-next-line unused-export — used by tests
export { extractProtectedTokens, normalizeProtectedToken };

/**
 * Verify that all protected tokens from the raw register name survived
 * in the LLM-generated expected name. If any are missing, append them
 * in normalized form so identity-bearing details are never lost.
 *
 * Exported for testing.
 */
// fallow-ignore-next-line unused-export — used by tests
export function verifyAndRestoreProtectedTokens(expectedName: string, rawName: string): string {
  const protectedTokens = extractProtectedTokens(rawName);
  if (protectedTokens.length === 0) return expectedName;

  const expectedLower = expectedName.toLowerCase();
  const missing: string[] = [];

  for (const token of protectedTokens) {
    const normalized = normalizeProtectedToken(token);
    // Check if the token's core content (number + significant chars) appears
    // in the expected name. Use loose matching so "2.64 oz" matches
    // against expected name containing "2.64"
    const tokenNumber = token.match(/\d+(?:\.\d+)?/)?.[0];
    if (tokenNumber && !expectedLower.includes(tokenNumber)) {
      missing.push(normalized);
    } else if (!tokenNumber && !expectedLower.includes(token.toLowerCase())) {
      missing.push(normalized);
    }
  }

  if (missing.length > 0) {
    const restored = `${expectedName.trim()} ${missing.join(' ')}`;
    console.log(`[LLMClient] Restored missing protected tokens: "${missing.map(redactIdentifier).join(', ')}" → "${redactIdentifier(restored)}"`);
    return restored;
  }

  return expectedName;
}

/**
 * Apply protected-token preservation to LCS fallback output.
 * If the raw register name contains size/weight/count tokens that the
 * LCS consensus omitted, append them.
 */
function lcsWithTokenGuard(titles: string[], originalName: string | undefined): string | null {
  const consensus = extractConsensusName(titles);
  if (!consensus || !originalName) return consensus;
  return verifyAndRestoreProtectedTokens(consensus, originalName);
}

export async function consolidateProductName(
  upc: string,
  searchResults: Array<{ title: string; snippet: string }>,
  originalName?: string,
  brandHint?: string | null,
  modelPolicy?: ModelPolicyView | null,
): Promise<string | null> {
  if (searchResults.length === 0 && !originalName) return null;

  // Extract protected tokens from the raw register name BEFORE any LLM call
  // so we can verify they survive. Log only a bounded non-sensitive form.
  const protectedTokens = originalName ? extractProtectedTokens(originalName) : [];
  if (protectedTokens.length > 0) {
    console.log(`[LLMClient] Protected tokens from raw name "${redactIdentifier(originalName ?? '')}": [${protectedTokens.map(redactIdentifier).join(', ')}]`);
  }

  try {
    let config: LlmConfig | null = null;
    try {
      config = getLlmConfigForTask('product_name_consolidation', {
        allowFallback: true,
        modelPolicy,
        protectedOperation: 'discovery_name_consolidation',
      });
    } catch (err) {
      // Protected operation (discovery_name_consolidation): fail closed on
      // EVERY resolution failure. Never select the generic DeepSeek → OpenAI
      // → Ollama chain, even when the caller omitted a policy context.
      if (err instanceof ModelPolicyDeniedError) {
        console.log(`[LLMClient] Model policy denied name consolidation (${err.code}); falling back to LCS`);
      } else {
        console.log('[LLMClient] Name consolidation policy resolution failed; falling back to LCS');
      }
      const titles = searchResults.map(r => r.title);
      if (originalName) titles.push(originalName);
      return lcsWithTokenGuard(titles, originalName);
    }
    if (!config) {
      console.log('[LLMClient] No LLM config found, falling back to LCS name extraction');
      const titles = searchResults.map(r => r.title);
      if (originalName) titles.push(originalName);
      return lcsWithTokenGuard(titles, originalName);
    }

    const itemsText = searchResults.length > 0
      ? searchResults
          .slice(0, 5)
          .map((r, i) => `[Result ${i + 1}]\nTitle: ${r.title}\nSnippet: ${r.snippet}`)
          .join('\n\n')
      : 'No search results found.';

    const systemPrompt = 'You are a precise product cataloging assistant. Your job is to generate a register-aligned expected product name from the raw catalog name and search hints.';

    const prompt = `We have a product in our catalog with the following metadata:
- Raw Catalog Name (authoritative): "${originalName || 'Unknown'}"
- Brand Hint: "${brandHint || 'Unknown'}"
- UPC/Barcode: "${upc}"

Candidate product page hints for the UPC:
${itemsText}

Task:
Generate a register-aligned expected product name. The Raw Catalog Name is the AUTHORITATIVE identity of the exact SKU we are adding. Search results are enrichment hints only.

Rules:
1. The Raw Catalog Name is authoritative. If search results are completely unrelated (e.g. random items, retail mismatch, bad barcode lookup), IGNORE them and focus on expanding the Raw Catalog Name.
2. Use search results to expand abbreviations, improve casing, add accents (e.g. "PATE" → "Pâté"), and confirm product-line wording — but NEVER remove or contradict identity-bearing details from the Raw Catalog Name.
3. PRESERVE ALL size, weight, count, volume, flavor, and variant tokens from the Raw Catalog Name as-is or normalized. These ARE product identifiers, NOT internal codes. Examples:
   - "2.64OZ" → "2.64 oz"
   - "10.5OZ" → "10.5 oz"
   - "5LB" → "5 lb"
   - "3PK" → "3-Pack"
   - "5CT" → "5 ct"
   - "SM" → "Small"
   - "LG" → "Large"
   - "XL" → "X-Large"
   - "6OZ" → "6 oz"
   - "48OZ" → "48 oz"
   - "30PK" → "30-Pack"
   Never drop these tokens. If a token from the Raw Catalog Name can be normalized, do so — but never remove it.
4. Expand common abbreviations naturally: "DNTL" → "Dental", "CHKN" or "CKN" → "Chicken", "TRKY" → "Turkey", "BEEF" → "Beef", "PATE" → "Pâté", "WET" → "Wet", "SLMN" → "Salmon".
5. Ensure the brand name is present at the start of the expected name.
6. Return ONLY the final expected name string. No quotes, explanations, bullet points, or markdown.

Register-Aligned Expected Name:`;

    console.log(`[LLMClient] Calling LLM (${config.provider}:${config.model}) for UPC ${redactIdentifier(upc)}`);
    const name = await callLlmForTask('product_name_consolidation', prompt, systemPrompt, {
      allowFallback: true,
      modelPolicy,
      protectedOperation: 'discovery_name_consolidation',
    });
    if (name == null) {
      throw new Error('LLM call returned null');
    }

    // Clean up potential quotes or markdown return structures from the LLM
    const cleaned = name.replace(/^['"`\s]+|['"`\s]+$/g, '').trim();
    if (cleaned.length > 5) {
      // Verify all protected tokens from the raw name survived
      const restored = originalName
        ? verifyAndRestoreProtectedTokens(cleaned, originalName)
        : cleaned;
      return restored;
    }
  } catch (err) {
    console.error(
      '[LLMClient] LLM name consolidation failed, falling back to LCS:',
      redactTransportText(err instanceof Error ? err.message : String(err)),
    );
  }

  // Fallback to LCS with token guard
  const titles = searchResults.map(r => r.title);
  if (originalName) titles.push(originalName);
  return lcsWithTokenGuard(titles, originalName);
}
