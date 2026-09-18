// Browser Investigation provider seam (T1).
//
// One bounded, provider-neutral interface. Only explicit investigate/repair
// routes (via the investigation service) may call it — worker polling,
// failure handling, diagnostics reads, and normal extraction must never
// invoke it (guarded by provider-isolation regression test).
//
// No Cloud SDK types or imports here. Requesting a cloud provider fails
// closed with `cloud_disabled`.

import type {
  InvestigationBudget,
  InvestigationInputSnapshot,
  InvestigationMode,
  InvestigationModelMetadata,
  InvestigationModelPolicy,
  InvestigationProviderId,
  InvestigationUsage,
} from '../../shared/schemas/browser-investigation';

export interface InvestigationProviderRequest {
  investigationId: string;
  workspaceId: string;
  domain: string;
  mode: InvestigationMode;
  sampleUrls: string[];
  inputSnapshot: InvestigationInputSnapshot;
  inputHash: string;
  budget: InvestigationBudget;
  modelPolicy: InvestigationModelPolicy;
  knownContext: Record<string, unknown>;
  runId: string;
}

export interface InvestigationProviderCompletion {
  investigationId: string;
  runId: string;
  provider: InvestigationProviderId;
  inputHash: string;
  /** Raw untrusted payload. The service schema-validates before accepting. */
  result: unknown;
  usage?: InvestigationUsage | null;
  actualModel?: InvestigationModelMetadata | null;
  durationMs?: number;
}

export class InvestigationProviderError extends Error {
  readonly code:
    | 'timeout'
    | 'provider_error'
    | 'budget_exhausted'
    | 'budget_not_enforceable'
    | 'cancelled'
    | 'isolation_unavailable'
    // #246 Tier 1 rendered deferral: default path refuses rendered-required
    // work with this stable code and performs no render attempt (#237 open).
    | 'render_deferred'
    | 'cloud_disabled'
    // #237 Tier 1 model-context blindness: reserved-holdout material in the
    // reasoning context fails the run with the validation-stage code.
    | 'holdout_exposed';
  constructor(
    code: InvestigationProviderError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'InvestigationProviderError';
    this.code = code;
  }
}

export interface InvestigationProvider {
  readonly id: InvestigationProviderId;
  invoke(request: InvestigationProviderRequest): Promise<InvestigationProviderCompletion>;
}

// ─── Registry + call accounting (regression-test seam) ───────────────────────

const registry = new Map<InvestigationProviderId, InvestigationProvider>();
let providerCallCount = 0;
const providerCallsById = new Map<string, number>();

export function registerInvestigationProvider(provider: InvestigationProvider): void {
  registry.set(provider.id, provider);
}

export function getInvestigationProvider(id: InvestigationProviderId): InvestigationProvider {
  const found = registry.get(id);
  if (!found) {
    throw new InvestigationProviderError(
      'isolation_unavailable',
      `isolation_unavailable: no investigation provider registered for ${id}`,
    );
  }
  return found;
}

/** Resolve a provider by id. Unknown/cloud ids fail closed — never fall back.
 * Since #235 production routes register only the real harness: resolving
 * `fake` there fails with `isolation_unavailable` (unregistered), while the
 * HTTP gate rejects `fake`/unknown earlier with `invalid_input`. Tests
 * register the fake explicitly in their own process. */
export function resolveInvestigationProvider(id: string): InvestigationProvider {
  if (id === 'fake' || id === 'local_browser_harness') {
    return getInvestigationProvider(id as InvestigationProviderId);
  }
  throw new InvestigationProviderError('cloud_disabled', `cloud_disabled: provider ${id} is disabled`);
}

export function resetInvestigationProviderCalls(): void {
  providerCallCount = 0;
  providerCallsById.clear();
}

export function getInvestigationProviderCallCount(providerId?: string): number {
  if (providerId) return providerCallsById.get(providerId) ?? 0;
  return providerCallCount;
}

function recordInvestigationProviderCall(providerId: string): void {
  providerCallCount += 1;
  providerCallsById.set(providerId, (providerCallsById.get(providerId) ?? 0) + 1);
}

/** Invoke through the registry with call accounting. Service-only entrypoint. */
export async function invokeInvestigationProvider(
  id: InvestigationProviderId,
  request: InvestigationProviderRequest,
): Promise<InvestigationProviderCompletion> {
  const provider = getInvestigationProvider(id);
  recordInvestigationProviderCall(provider.id);
  return provider.invoke(request);
}
