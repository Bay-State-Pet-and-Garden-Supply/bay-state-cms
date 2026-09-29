/**
 * Classification model-policy gateway (issue #17 work item A).
 *
 * Enforces the workspace's frozen classification model policy at the LLM
 * transport boundary for protected classification/onboarding operations.
 *
 * Fail-closed invariants (non-negotiable):
 * - `fetch` is never invoked when policy is absent/tampered, text policy is
 *   `local_only` with a non-`local` provider, locality is undeclared, the
 *   resolved endpoint is not loopback/local-process, the route is unknown,
 *   the credential is missing, or the fallback is not explicit.
 * - A provider name never implies locality; a `local` declaration does not
 *   excuse a remote base URL.
 * - The frozen policy is re-checked at the transport boundary.
 *
 * Provider/model for protected operations resolve from
 * `stageOverrides[stageName]` or the snapshot default. `llm_task_configs` and
 * the `model` column on `api_keys` never select provider/model for protected
 * calls; `api_keys` supplies only the credential/base URL for the
 * already-authorized provider.
 */
import { sha256Hex } from '../shared/stable-id';
import type { ModelPolicyConfigV2 } from '../shared/schemas/classification';
import { isPrivateLanHost } from '../ai/provider-connections';

export type ProviderLocality = 'local' | 'trusted_lan' | 'cloud' | 'hybrid';

export type ProtectedOperation =
  | 'evidence_extraction'
  | 'product_type_ranking'
  | 'attribute_ranking'
  | 'page_assignment'
  | 'cohort_page_assignment'
  | 'cohort_page_assignment_parent'
  | 'title_consolidation'
  | 'cohort_title_consolidation'
  | 'distributor_copy_consolidation'
  | 'discovery_name_consolidation'
  | 'sitemap_selection'
  // P3 value-production ladder (plan B.P3.3): id-constrained residual-gap
  // resolution for the flag-gated `value_gap_abstain` stage.
  | 'value_gap_resolution';

/**
 * Classification stage key used for `stageOverrides` lookup per protected
 * operation. `null` means the operation is not tied to a classification
 * stage and resolves from the snapshot default provider/model.
 */
const PROTECTED_OPERATION_STAGE: Readonly<Record<ProtectedOperation, string | null>> = {
  evidence_extraction: 'evidence_extraction',
  product_type_ranking: 'primary_product_type_proposal',
  attribute_ranking: 'product_attribute_proposals',
  page_assignment: 'category_page_proposals',
  cohort_page_assignment: 'category_page_proposals',
  cohort_page_assignment_parent: 'category_page_proposals',
  title_consolidation: 'name_consolidation',
  cohort_title_consolidation: 'name_consolidation',
  distributor_copy_consolidation: 'name_consolidation',
  discovery_name_consolidation: 'name_consolidation',
  sitemap_selection: null,
  value_gap_resolution: 'value_gap_abstain',
};

/** Stable denial reason codes (typed; serializable). */
export type PolicyDenialCode =
  | 'policy_absent'
  | 'policy_tampered'
  | 'policy_disabled'
  | 'locality_undeclared'
  | 'text_local_only_non_local_provider'
  | 'image_local_only_non_local_provider'
  | 'endpoint_non_loopback'
  | 'route_unknown'
  | 'credential_missing'
  | 'implicit_fallback_forbidden'
  | 'provider_unknown';

export class ModelPolicyDeniedError extends Error {
  readonly code: PolicyDenialCode;
  readonly operation: ProtectedOperation;
  readonly provider?: string;

  constructor(code: PolicyDenialCode, operation: ProtectedOperation, provider?: string, detail?: string) {
    const providerPart = provider ? ` provider="${provider}"` : '';
    super(`Model policy denied ${operation} (${code})${providerPart}${detail ? `: ${detail}` : ''}`);
    this.name = 'ModelPolicyDeniedError';
    this.code = code;
    this.operation = operation;
    this.provider = provider;
  }
}

export interface StageOverrideView {
  provider?: string;
  model?: string;
  fallbackProvider: string | null;
  fallbackModel: string | null;
}

/**
 * Immutable, digest-bound view of the classification model policy. The digest
 * covers every routing-relevant field (provider/model/locality/overrides and
 * both data-sharing policies); it is recomputed at the transport boundary so
 * tampering after snapshot creation is detected.
 */
export type ClassificationDataSharingPolicy = 'local_only' | 'this_device_only' | 'trusted_lan_allowed' | 'cloud_allowed';

export interface ModelPolicyView {
  readonly defaultProvider: string;
  readonly defaultModel: string;
  readonly providerLocalities: Readonly<Record<string, ProviderLocality>>;
  readonly stageOverrides: Readonly<Record<string, StageOverrideView>>;
  readonly textDataSharing: ClassificationDataSharingPolicy;
  readonly imageDataSharing: ClassificationDataSharingPolicy;
  /** Optional binding to the runtime snapshot hash (tamper detection). */
  readonly snapshotHash?: string;
  readonly policyDigest: string;
}

export interface ModelPolicyViewOptions {
  /** Bind the digest to a runtime snapshot hash; required for run-bound views. */
  snapshotHash?: string;
}

export interface ProviderCredential {
  provider: string;
  apiKey: string;
  baseUrl: string | null;
  model: string | null;
}

export interface ModelRoute {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  locality: ProviderLocality;
  /** Explicit paired fallback from the stage override, or null. */
  fallbackProvider: string | null;
  fallbackModel: string | null;
  /** True when provider/model came from a stage override rather than the default. */
  fromOverride: boolean;
}

export interface ModelPolicyGatewayDeps {
  /** Credential lookup keyed by provider name (api_keys service name). */
  getCredential(provider: string): ProviderCredential | null;
  /** Default base URL per provider when the credential has none configured. */
  defaultBaseUrls: Readonly<Record<string, string>>;
  /** Optional override for the loopback test (defaults to isLoopbackBaseUrl). */
  isLoopback?: (baseUrl: string) => boolean;
}

const DEFAULT_IS_LOOPBACK = isLoopbackBaseUrl;

/** Recursively deep-freeze a value (plain objects and arrays only). */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Build a canonical, frozen policy view with a content-addressed digest. */
export function buildModelPolicyView(
  policy: ModelPolicyConfigV2,
  options: ModelPolicyViewOptions = {},
): ModelPolicyView {
  const providerLocalities: Record<string, ProviderLocality> = {};
  for (const [provider, locality] of Object.entries(policy.providerLocalities ?? {})) {
    providerLocalities[provider] = locality;
  }
  const stageOverrides: Record<string, StageOverrideView> = {};
  for (const [stageName, override] of Object.entries(policy.stageOverrides ?? {})) {
    stageOverrides[stageName] = {
      provider: override.provider,
      model: override.model,
      fallbackProvider: override.fallbackProvider,
      fallbackModel: override.fallbackModel,
    };
  }

  const digestPayload = {
    defaultProvider: policy.defaultProvider,
    defaultModel: policy.defaultModel,
    providerLocalities,
    stageOverrides,
    textDataSharing: policy.textDataSharing,
    imageDataSharing: policy.imageDataSharing,
    ...(options.snapshotHash ? { snapshotHash: options.snapshotHash } : {}),
  };
  const policyDigest = sha256Hex(JSON.stringify(digestPayload));

  // Deep-freeze every nested map so the view cannot be tampered with between
  // snapshot creation and the transport boundary (issue #17 pass 1b).
  const view: ModelPolicyView = Object.freeze({
    defaultProvider: policy.defaultProvider,
    defaultModel: policy.defaultModel,
    providerLocalities: deepFreeze(providerLocalities),
    stageOverrides: deepFreeze(stageOverrides),
    textDataSharing: policy.textDataSharing,
    imageDataSharing: policy.imageDataSharing,
    ...(options.snapshotHash ? { snapshotHash: options.snapshotHash } : {}),
    policyDigest,
  });
  return view;
}

/**
 * Re-compute the digest from the current view and fail when it no longer
 * matches the frozen digest (policy tampering between snapshot and transport).
 */
export function assertModelPolicyIntact(view: ModelPolicyView): void {
  if (!view || !view.policyDigest) return;
  const recomputed = buildModelPolicyView(
    view as unknown as ModelPolicyConfigV2,
    view.snapshotHash ? { snapshotHash: view.snapshotHash } : {},
  );
  if (recomputed.policyDigest !== view.policyDigest) {
    throw new ModelPolicyDeniedError('policy_tampered', 'evidence_extraction');
  }
}

/**
 * Bound and redact transport text (provider error bodies, URLs, request
 * identifiers) before it reaches logs or thrown errors (issue #17 pass 1b,
 * pass 1c). Strips bearer tokens, Basic-auth base64 segments, sk-* keys, and
 * quoted/unquoted credential key/value forms for the common secret keys;
 * caps length at `maxLength` chars.
 */
export function redactTransportText(text: string, maxLength = 200): string {
  let t = String(text ?? '');
  // Iteratively peel escaped-quote layers and re-apply the credential
  // patterns until a fixpoint (bounded), so any depth of nested
  // JSON.stringify escaping is scrubbed (issue #17 pass 1d). Provider
  // error bodies may be doubly/triply stringified; a single unescape pass
  // leaves the credential in a form the patterns cannot match.
  const MAX_UNESCAPE_PASSES = 5;
  for (let i = 0; i < MAX_UNESCAPE_PASSES; i++) {
    // Halve escape depth per pass: collapse 4-backslash, 2-backslash, and
    // 1-backslash quoted forms so deeply nested stringification (any depth
    // of JSON.stringify escaping) is peeled within the bounded passes.
    const unescaped = t
      .replace(/\\\\\\"/g, '\\"') // 4 backslashes + " -> \"
      .replace(/\\\\"/g, '"') // 2 backslashes + " -> "
      .replace(/\\"/g, '"') // 1 backslash + " -> "
      .replace(/\\\\\\'/g, "\\'")
      .replace(/\\\\'/g, "'")
      .replace(/\\'/g, "'");
    const next = unescaped
      // Authorization: Bearer <token>
      .replace(/\b[Bb]earer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [REDACTED]')
      // Authorization: Basic <base64> (tolerates JSON quoting around the value)
      .replace(
        /(["']?)(?:authorization|auth)\1?\s*[=:]\s*["']?basic\s+[A-Za-z0-9+/=]{6,}/gi,
        'authorization=[REDACTED]',
      )
      // Standalone Basic <base64> segments
      .replace(/\bbasic\s+[A-Za-z0-9+/=]{6,}/gi, 'Basic [REDACTED]')
      // sk-* secret keys
      .replace(/\bsk-[A-Za-z0-9_-]{8,}/gi, 'sk-[REDACTED]')
      // Common credential keys in quoted or unquoted key=value / key:"value" forms
      .replace(
        /(["']?)(api[_-]?key|apikey|token|access_token|refresh_token|password|secret|authorization|bearer|auth|key)\1?\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;"']+)/gi,
        '$2=[REDACTED]',
      );
    if (next === t && unescaped === t) {
      break;
    }
    t = next;
  }
  if (t.length > maxLength) {
    t = `${t.slice(0, maxLength)}…`;
  }
  return t;
}

/**
 * Redact a URL for logging: strip query string and hash (signed URLs carry
 * credentials in the query), keep scheme+host+path.
 */
export function redactImageUrl(url: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    // P2 redaction pass: never persist or log userinfo credentials.
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    // Non-URL string: keep a bounded prefix, never query-looking content.
    return url.split(/[?#]/)[0].slice(0, 120);
  }
}

/**
 * Bounded, non-sensitive identifier for logs (never the raw UPC/name/token).
 * Returns a short prefix + length so the operator can correlate without
 * exposing the value.
 */
export function redactIdentifier(id: string): string {
  if (!id) return '';
  const s = String(id);
  if (s.length <= 8) return '[id]';
  return `${s.slice(0, 4)}…(${s.length})`;
}

/**
 * True when the base URL resolves to the local machine (localhost, 127.0.0.1,
 * ::1) over http/https. Non-loopback hosts, bare domains without a scheme,
 * file/data schemes, and invalid URLs are false (fail closed).
 */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
  if (host.endsWith('.localhost')) return true;
  // Loopback ranges: 127.0.0.0/8
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return host.split('.').every(part => Number(part) <= 255);
  }
  return false;
}

/**
 * Resolve + validate the primary route for a protected operation.
 *
 * When `requiresImage` is true (vision/image-bearing calls), the image
 * data-sharing policy is enforced alongside the text policy: an image may
 * never leave the machine under `imageDataSharing: 'local_only'` unless the
 * resolved provider is declared local.
 */
export function resolveModelRoute(
  view: ModelPolicyView,
  operation: ProtectedOperation,
  deps: ModelPolicyGatewayDeps,
  requiresImage = false,
): ModelRoute {
  assertModelPolicyIntact(view);

  const stageName = PROTECTED_OPERATION_STAGE[operation];
  const override = stageName ? view.stageOverrides[stageName] : undefined;
  const provider = override?.provider ?? view.defaultProvider;
  const model = override?.model ?? view.defaultModel;

  const route = resolveRoute(
    provider,
    model,
    view,
    operation,
    deps,
    override?.fallbackProvider ?? null,
    override?.fallbackModel ?? null,
    Boolean(override?.provider ?? override?.model),
    requiresImage,
  );
  return route;
}

function resolveRoute(
  provider: string,
  model: string,
  view: ModelPolicyView,
  operation: ProtectedOperation,
  deps: ModelPolicyGatewayDeps,
  fallbackProvider: string | null,
  fallbackModel: string | null,
  fromOverride: boolean,
  requiresImage = false,
): ModelRoute {
  if (!provider || !model) {
    throw new ModelPolicyDeniedError('route_unknown', operation, provider || undefined);
  }
  const locality = view.providerLocalities[provider];
  if (!locality) {
    throw new ModelPolicyDeniedError('locality_undeclared', operation, provider);
  }
  if ((view.textDataSharing === 'local_only' || view.textDataSharing === 'this_device_only') && locality !== 'local') {
    throw new ModelPolicyDeniedError('text_local_only_non_local_provider', operation, provider);
  }
  if (view.textDataSharing === 'trusted_lan_allowed' && locality !== 'local' && locality !== 'trusted_lan') {
    throw new ModelPolicyDeniedError('text_local_only_non_local_provider', operation, provider);
  }

  // Image-bearing operations additionally enforce imageDataSharing:
  if (requiresImage) {
    if ((view.imageDataSharing === 'local_only' || view.imageDataSharing === 'this_device_only') && locality !== 'local') {
      throw new ModelPolicyDeniedError('image_local_only_non_local_provider', operation, provider);
    }
    if (view.imageDataSharing === 'trusted_lan_allowed' && locality !== 'local' && locality !== 'trusted_lan') {
      throw new ModelPolicyDeniedError('image_local_only_non_local_provider', operation, provider);
    }
  }

  const credential = deps.getCredential(provider);
  if (!credential) {
    throw new ModelPolicyDeniedError('credential_missing', operation, provider);
  }

  const baseUrl = (credential.baseUrl || deps.defaultBaseUrls[provider] || '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw new ModelPolicyDeniedError('route_unknown', operation, provider, 'no base URL resolved');
  }

  // A declared-local provider must always resolve to a loopback endpoint.
  // A trusted_lan provider must resolve to a private LAN or loopback endpoint.
  if (locality === 'local') {
    const isLoopback = deps.isLoopback ?? DEFAULT_IS_LOOPBACK;
    if (!isLoopback(baseUrl)) {
      throw new ModelPolicyDeniedError('endpoint_non_loopback', operation, provider, baseUrl);
    }
  } else if (locality === 'trusted_lan') {
    const isLoopback = deps.isLoopback ?? DEFAULT_IS_LOOPBACK;
    let isLan = false;
    try {
      const host = new URL(baseUrl).hostname;
      isLan = isLoopback(baseUrl) || isPrivateLanHost(host);
    } catch {
      isLan = false;
    }
    if (!isLan) {
      throw new ModelPolicyDeniedError('endpoint_non_loopback', operation, provider, `${baseUrl} (not a private LAN host)`);
    }
  }

  return {
    provider,
    model,
    baseUrl,
    apiKey: credential.apiKey,
    locality,
    fallbackProvider,
    fallbackModel,
    fromOverride,
  };
}

/**
 * Validate the explicit paired fallback (from the stage override) with the
 * same locality/endpoint rules. Returns null when no fallback is declared.
 * Implicit generic fallback is impossible: without an explicit fallback pair,
 * there is no fallback route at all.
 */
export function resolveFallbackRoute(
  view: ModelPolicyView,
  operation: ProtectedOperation,
  deps: ModelPolicyGatewayDeps,
  requiresImage = false,
): ModelRoute | null {
  assertModelPolicyIntact(view);
  const stageName = PROTECTED_OPERATION_STAGE[operation];
  const override = stageName ? view.stageOverrides[stageName] : undefined;
  const fallbackProvider = override?.fallbackProvider ?? null;
  const fallbackModel = override?.fallbackModel ?? null;
  if (!fallbackProvider) return null;
  if (!fallbackModel) {
    throw new ModelPolicyDeniedError('implicit_fallback_forbidden', operation, fallbackProvider);
  }
  return resolveRoute(fallbackProvider, fallbackModel, view, operation, deps, null, null, true, requiresImage);
}
