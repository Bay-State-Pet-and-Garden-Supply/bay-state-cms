// Browser-Assisted Extraction Investigation — T1 lifecycle foundation.
//
// Provider-neutral, workspace-scoped investigation persistence contract.
// This module is pure (Zod + string/canonical JSON only): no DB, no network,
// no provider SDK imports. Cloud browser integration stays disabled in T1.
//
// The contract surface below is consumed incrementally by T2 (compiler),
// T3 (harness), and T5 (governance/workspace flow); symbols without a T1
// importer are forward-looking API, not dead code.
// fallow-ignore-file unused-export

import { z } from 'zod';
import {
  CodeAdapterNeedSchema,
  FieldRecommendationSchema,
  InvestigationPlatformSchema,
  PolicyIdentitySchema,
  PolicyStructureSchema,
} from './browser-investigation-policy';

export const INVESTIGATION_RESULT_VERSION = 1 as const;

export const InvestigationModeSchema = z.enum(['domain_onboarding', 'drift_repair']);
export type InvestigationMode = z.infer<typeof InvestigationModeSchema>;

export const InvestigationStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'discarded',
]);
// Forward-looking T2/T5 API: lifecycle status type for compiler and workspace flows.
// fallow-ignore-next-line unused-type
export type InvestigationStatus = z.infer<typeof InvestigationStatusSchema>;

export const TERMINAL_INVESTIGATION_STATUSES: readonly InvestigationStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'discarded',
];

export function isTerminalInvestigationStatus(status: InvestigationStatus): boolean {
  return (TERMINAL_INVESTIGATION_STATUSES as readonly string[]).includes(status);
}

export const ACTIVE_INVESTIGATION_STATUSES: readonly InvestigationStatus[] = ['queued', 'running'];

export function isActiveInvestigationStatus(status: InvestigationStatus): boolean {
  return (ACTIVE_INVESTIGATION_STATUSES as readonly string[]).includes(status);
}

/** Providers known to the seam. `fake` persists only for explicit test
 * injection (never launchable from production routes since #235); `cloud`
 * is intentionally absent: requesting it must fail closed with
 * `cloud_disabled` and no Cloud SDK ships. */
export const InvestigationProviderIdSchema = z.enum(['fake', 'local_browser_harness']);
export type InvestigationProviderId = z.infer<typeof InvestigationProviderIdSchema>;

/** Operator-safe stable failure codes. Never carry secrets, prompts, or raw HTML. */
export const InvestigationFailureCodeSchema = z.enum([
  'invalid_input',
  'conflict_active_investigation',
  'invalid_transition',
  'not_found',
  'workspace_mismatch',
  'budget_exhausted',
  'budget_not_enforceable',
  'timeout',
  'provider_error',
  'malformed_result',
  'evidence_missing',
  'cancelled',
  'replay_rejected',
  'stale_completion',
  'isolation_unavailable',
  'cloud_disabled',
  // T2 compiler/apply outcomes (additive: T1 lifecycle codes unchanged).
  'unappliable_proposal',
  'already_applied',
  'stale_proposal',
  // T4 validation outcomes (additive).
  'holdout_exposed',
  // T5 holdout governance (additive): a later validation dropped a
  // previously reserved holdout instead of running it.
  'reserved_holdout_dropped',
  // #234 server-authoritative apply (additive): client-submitted validation
  // status / holdout counts presented as credentials, or a persisted
  // validation record that fails integrity/binding checks.
  'validation_untrusted',
]);
export type InvestigationFailureCode = z.infer<typeof InvestigationFailureCodeSchema>;

export const DEFAULT_INVESTIGATION_BUDGET = {
  maxPages: 5,
  maxReads: 20,
  maxModelCalls: 8,
  timeoutMs: 10 * 60 * 1000,
} as const;

/**
 * T3 resource budgets (design-doc §"Observation and inference budgets").
 * Versioned investigation configuration, shown before launch via
 * `describeInvestigationBudget` and enforced live at the broker (network /
 * byte caps), capture (artifact caps), and dispatch (model-payload caps)
 * layers. Defaults are maxima: overrides may lower caps but never raise
 * them — an oversized response cannot silently increase the budget.
 */
export const DEFAULT_INVESTIGATION_RESOURCE_BUDGET = {
  /** Per-response body cap, enforced on transferred AND decompressed bytes while streaming. */
  maxResponseBytesPerResponse: 5 * 1024 * 1024,
  /** Aggregate transferred body bytes per investigation (assets, redirects, retries included). */
  maxTotalResponseBytesTransferred: 50 * 1024 * 1024,
  /** Aggregate decompressed body bytes per investigation. */
  maxTotalResponseBytesDecompressed: 50 * 1024 * 1024,
  /** Broker request attempts per investigation (subresources, redirects, denied, retries). */
  maxRequestAttempts: 500,
  /** Retained DOM/state/network artifact cap each (screenshots included). */
  maxArtifactBytesPerArtifact: 5 * 1024 * 1024,
  /** Retained artifact total per investigation. */
  maxArtifactBytesTotal: 50 * 1024 * 1024,
  /** Model-visible text/DOM/JSON/network-body observation cap per operation, UTF-8. */
  maxObservationBytesPerOperation: 32 * 1024,
  /** Model input cap per call, including instructions/schemas/history. */
  maxModelInputBytesPerCall: 64 * 1024,
  /** Cumulative model input cap, including repeated history. */
  maxModelInputBytesTotal: 256 * 1024,
  /** Enforceable provider output-token limit required before dispatch. */
  maxModelOutputTokensPerCall: 4096,
  /** Accepted structured result cap per call. */
  maxModelResultBytesPerCall: 32 * 1024,
  /** Image attachments across all calls (zero without image-sharing permission). */
  maxImageAttachmentsTotal: 2,
  /** Per-image byte cap. */
  maxImageBytesPerImage: 512 * 1024,
  /** Per-image longest-edge pixel cap. */
  maxImageLongestEdgePx: 1024,
  /** Declarative-query selector length cap (matches the policy-selector cap). */
  maxSelectorLength: 512,
  /** Declarative-query returned-match cap. */
  maxSelectorMatches: 100,
  /** JSON/pointer depth cap. */
  maxJsonPointerDepth: 32,
  /** JSON nodes visited per operation. */
  maxJsonNodesVisited: 10_000,
  /** Redirect hops revalidated per fetch (every hop re-resolves + revalidates). */
  maxRedirectHops: 5,
} as const;

export const InvestigationBudgetSchema = z.object({
  maxPages: z.number().int().min(1).max(5).default(DEFAULT_INVESTIGATION_BUDGET.maxPages),
  maxReads: z.number().int().min(1).max(20).default(DEFAULT_INVESTIGATION_BUDGET.maxReads),
  maxModelCalls: z.number().int().min(1).max(8).default(DEFAULT_INVESTIGATION_BUDGET.maxModelCalls),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(10 * 60 * 1000)
    .default(DEFAULT_INVESTIGATION_BUDGET.timeoutMs),
  /** Optional monetary ceiling. A provider that cannot enforce it must fail
   * before dispatch with `budget_not_enforceable`; post-hoc checks are not caps. */
  maxCostUsd: z.number().positive().optional(),
  // ── T3 resource budgets (defaults are maxima; overrides may only lower) ──
  maxResponseBytesPerResponse: z
    .number()
    .int()
    .min(1024)
    .max(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxResponseBytesPerResponse)
    .default(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxResponseBytesPerResponse),
  maxTotalResponseBytesTransferred: z
    .number()
    .int()
    .min(1024)
    .max(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxTotalResponseBytesTransferred)
    .default(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxTotalResponseBytesTransferred),
  maxTotalResponseBytesDecompressed: z
    .number()
    .int()
    .min(1024)
    .max(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxTotalResponseBytesDecompressed)
    .default(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxTotalResponseBytesDecompressed),
  maxRequestAttempts: z
    .number()
    .int()
    .min(1)
    .max(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxRequestAttempts)
    .default(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxRequestAttempts),
  maxArtifactBytesPerArtifact: z
    .number()
    .int()
    .min(1024)
    .max(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxArtifactBytesPerArtifact)
    .default(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxArtifactBytesPerArtifact),
  maxArtifactBytesTotal: z
    .number()
    .int()
    .min(1024)
    .max(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxArtifactBytesTotal)
    .default(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxArtifactBytesTotal),
  maxObservationBytesPerOperation: z
    .number()
    .int()
    .min(1024)
    .max(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxObservationBytesPerOperation)
    .default(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxObservationBytesPerOperation),
  maxModelInputBytesPerCall: z
    .number()
    .int()
    .min(1024)
    .max(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxModelInputBytesPerCall)
    .default(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxModelInputBytesPerCall),
  maxModelInputBytesTotal: z
    .number()
    .int()
    .min(1024)
    .max(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxModelInputBytesTotal)
    .default(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxModelInputBytesTotal),
  maxModelOutputTokensPerCall: z
    .number()
    .int()
    .min(1)
    .max(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxModelOutputTokensPerCall)
    .default(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxModelOutputTokensPerCall),
  maxModelResultBytesPerCall: z
    .number()
    .int()
    .min(1024)
    .max(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxModelResultBytesPerCall)
    .default(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxModelResultBytesPerCall),
  maxImageAttachmentsTotal: z
    .number()
    .int()
    .min(0)
    .max(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxImageAttachmentsTotal)
    .default(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxImageAttachmentsTotal),
  maxImageBytesPerImage: z
    .number()
    .int()
    .min(1024)
    .max(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxImageBytesPerImage)
    .default(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxImageBytesPerImage),
  maxImageLongestEdgePx: z
    .number()
    .int()
    .min(16)
    .max(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxImageLongestEdgePx)
    .default(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxImageLongestEdgePx),
  maxSelectorLength: z
    .number()
    .int()
    .min(1)
    .max(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxSelectorLength)
    .default(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxSelectorLength),
  maxSelectorMatches: z
    .number()
    .int()
    .min(1)
    .max(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxSelectorMatches)
    .default(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxSelectorMatches),
  maxJsonPointerDepth: z
    .number()
    .int()
    .min(1)
    .max(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxJsonPointerDepth)
    .default(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxJsonPointerDepth),
  maxJsonNodesVisited: z
    .number()
    .int()
    .min(1)
    .max(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxJsonNodesVisited)
    .default(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxJsonNodesVisited),
  maxRedirectHops: z
    .number()
    .int()
    .min(0)
    .max(10)
    .default(DEFAULT_INVESTIGATION_RESOURCE_BUDGET.maxRedirectHops),
});
export type InvestigationBudget = z.infer<typeof InvestigationBudgetSchema>;

/** One operator-visible budget row, shown before launch and stored with the input. */
export interface InvestigationBudgetRow {
  key: string;
  label: string;
  value: string;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${trimNum(n / (1024 * 1024))} MiB`;
  if (n >= 1024) return `${trimNum(n / 1024)} KiB`;
  return `${n} B`;
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function formatMs(ms: number): string {
  if (ms >= 60_000) return `${trimNum(ms / 60_000)} min`;
  if (ms >= 1000) return `${trimNum(ms / 1000)} s`;
  return `${ms} ms`;
}

/**
 * Operator-visible budget preview. Routes return this before launch so the
 * action, byte, token, image, artifact, and request-attempt budgets are
 * shown up front; the same caps are enforced live at the broker, capture,
 * and dispatch layers. Pure and Vitest-safe.
 */
// fallow-ignore-next-line unused-export — consumed by routes + tests
export function describeInvestigationBudget(budget: InvestigationBudget): InvestigationBudgetRow[] {
  return [
    { key: 'maxPages', label: 'Product pages', value: `up to ${budget.maxPages}` },
    { key: 'maxReads', label: 'Model-visible read operations', value: `up to ${budget.maxReads}` },
    { key: 'maxModelCalls', label: 'Model calls', value: `up to ${budget.maxModelCalls}` },
    { key: 'timeoutMs', label: 'Wall-clock timeout', value: formatMs(budget.timeoutMs) },
    {
      key: 'maxCostUsd',
      label: 'Cost ceiling',
      value: budget.maxCostUsd != null ? `$${budget.maxCostUsd}` : 'none requested',
    },
    {
      key: 'maxResponseBytesPerResponse',
      label: 'Response body (per response)',
      value: formatBytes(budget.maxResponseBytesPerResponse),
    },
    {
      key: 'maxTotalResponseBytes',
      label: 'Response bodies (total, transferred + decompressed)',
      value: `${formatBytes(budget.maxTotalResponseBytesTransferred)} each`,
    },
    {
      key: 'maxRequestAttempts',
      label: 'Broker request attempts',
      value: `up to ${budget.maxRequestAttempts}`,
    },
    {
      key: 'maxArtifactBytes',
      label: 'Retained artifacts',
      value: `${formatBytes(budget.maxArtifactBytesPerArtifact)} each / ${formatBytes(budget.maxArtifactBytesTotal)} total`,
    },
    {
      key: 'maxObservationBytesPerOperation',
      label: 'Observation (per operation)',
      value: formatBytes(budget.maxObservationBytesPerOperation),
    },
    {
      key: 'maxModelInputBytes',
      label: 'Model input',
      value: `${formatBytes(budget.maxModelInputBytesPerCall)} per call / ${formatBytes(budget.maxModelInputBytesTotal)} total`,
    },
    {
      key: 'maxModelOutputTokensPerCall',
      label: 'Model output',
      value: `${budget.maxModelOutputTokensPerCall} tokens + ${formatBytes(budget.maxModelResultBytesPerCall)} result per call`,
    },
    {
      key: 'maxImages',
      label: 'Image attachments',
      value:
        budget.maxImageAttachmentsTotal === 0
          ? 'none'
          : `up to ${budget.maxImageAttachmentsTotal} × ${formatBytes(budget.maxImageBytesPerImage)}, ${budget.maxImageLongestEdgePx}px longest edge (requires image-sharing permission; otherwise zero)`,
    },
    {
      key: 'maxQuery',
      label: 'Declarative query bounds',
      value: `selector ${budget.maxSelectorLength} chars / ${budget.maxSelectorMatches} matches, pointer depth ${budget.maxJsonPointerDepth}, ${budget.maxJsonNodesVisited} JSON nodes`,
    },
    { key: 'maxRedirectHops', label: 'Redirect hops', value: `up to ${budget.maxRedirectHops}` },
  ];
}

export const InvestigationModelPolicySchema = z.object({
  /** Cloud text analysis requires explicit opt-in. Default off. */
  allowCloudTextAnalysis: z.boolean().default(false),
  /** Image sharing is a separate permission from text. Default off. */
  allowImageSharing: z.boolean().default(false),
});
export type InvestigationModelPolicy = z.infer<typeof InvestigationModelPolicySchema>;

export const InvestigationBudgetInputSchema = InvestigationBudgetSchema.partial();
// Forward-looking T2/T5 API: partial budget overrides for compiler and workspace flows.
// fallow-ignore-next-line unused-type
export type InvestigationBudgetInput = z.infer<typeof InvestigationBudgetInputSchema>;

export function resolveInvestigationBudget(input?: InvestigationBudgetInput): InvestigationBudget {
  return InvestigationBudgetSchema.parse(input ?? {});
}

/** Bounded request input for an explicit operator investigation. */
export const InvestigationRequestInputSchema = z.object({
  domain: z.string().min(1).max(253),
  mode: InvestigationModeSchema,
  sampleUrls: z.array(z.string().url()).min(1).max(5),
  budget: InvestigationBudgetInputSchema.optional(),
  modelPolicy: InvestigationModelPolicySchema.partial().optional(),
  knownContext: z.record(z.string(), z.unknown()).optional(),
});
// Forward-looking T2/T5 API: typed request input for compiler and workspace flows.
// fallow-ignore-next-line unused-type
export type InvestigationRequestInput = z.infer<typeof InvestigationRequestInputSchema>;

export const InvestigationModelMetadataSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  requested: z.string().min(1).optional(),
  actual: z.string().min(1).optional(),
});
export type InvestigationModelMetadata = z.infer<typeof InvestigationModelMetadataSchema>;

export const InvestigationUsageSchema = z.object({
  modelCalls: z.number().int().min(0).optional(),
  pagesVisited: z.number().int().min(0).optional(),
  readsPerformed: z.number().int().min(0).optional(),
  durationMs: z.number().int().min(0).optional(),
  /** Billed cost when the provider reports it; never fabricated. */
  costUsd: z.number().min(0).nullable().optional(),
  /** Rate-derived estimates must stay distinct from billed cost. */
  costBasis: z.enum(['billed', 'estimated', 'unavailable']).default('unavailable'),
  // ── T3 cumulative resource counters (reported by the broker/capture/dispatch layers) ──
  requestAttempts: z.number().int().min(0).optional(),
  responseBytesTransferred: z.number().int().min(0).optional(),
  responseBytesDecompressed: z.number().int().min(0).optional(),
  artifactsRetainedBytes: z.number().int().min(0).optional(),
  artifactsCount: z.number().int().min(0).optional(),
  modelInputBytesTotal: z.number().int().min(0).optional(),
  modelOutputTokensTotal: z.number().int().min(0).optional(),
  imageAttachmentsTotal: z.number().int().min(0).optional(),
});
export type InvestigationUsage = z.infer<typeof InvestigationUsageSchema>;

/**
 * Cap on one observation's detail text in a stored result. The in-container
 * analyzer caps observations at the run's per-operation budget (up to 32 KiB);
 * the harness clamps to this result cap and marks the observation incomplete,
 * so a rich page cannot produce a result the service rejects as malformed.
 */
export const MAX_RESULT_OBSERVATION_DETAIL_CHARS = 4000;

/** One untrusted, source-attributed observation. Evidence, not proof. */
export const InvestigationObservationSchema = z.object({
  kind: z.string().min(1).max(120),
  sourceUrl: z.string().url(),
  /** Hash of the captured artifact bytes (hex). Prefix hashes must not
   * masquerade as full-content hashes — producers record full hashes only. */
  artifactHash: z.string().min(8).max(128),
  detail: z.string().max(MAX_RESULT_OBSERVATION_DETAIL_CHARS).optional(),
  incomplete: z.boolean().default(false),
});
// Forward-looking T2 API: observation type for the deterministic compiler.
// fallow-ignore-next-line unused-type
export type InvestigationObservation = z.infer<typeof InvestigationObservationSchema>;

/**
 * Versioned, schema-validated but UNTRUSTED typed investigation result.
 * Validation success never implies extraction correctness, health,
 * activation, release, or image attestation. The deterministic compiler
 * (T2) decides what is compilable; unsupported paths yield
 * `requires_code_adapter` there, not here.
 *
 * T2 structured findings (platform, structures, field recommendations,
 * identity requirements, adapter needs) are additive and optional: T1 rows
 * and minimal fixtures still validate. The compiler treats absent structure
 * as one implicit structure and absent recommendations as missing evidence.
 * `recommendedStrategy` stays a display-only string — the compiler never
 * branches on it, so model-influenced prose cannot select executables.
 */
export const InvestigationResultSchema = z.object({
  version: z.literal(INVESTIGATION_RESULT_VERSION),
  summary: z.string().min(1).max(4000),
  observations: z.array(InvestigationObservationSchema).min(1).max(50),
  evidenceRefs: z.array(z.string().min(1).max(500)).max(50).default([]),
  gaps: z.array(z.string().min(1).max(1000)).max(50).default([]),
  recommendedStrategy: z.string().min(1).max(2000).optional(),
  renderedBrowserRequired: z.boolean().default(false),
  renderedBrowserReason: z.string().max(2000).optional(),
  platform: InvestigationPlatformSchema.optional(),
  structures: z.array(PolicyStructureSchema).max(8).default([]),
  /** Structure ids the investigator declares mutually incompatible: the
   * compiler must block a single domain-wide policy, never merge them. */
  incompatibleStructureIds: z.array(z.string().min(1).max(64)).max(8).default([]),
  fieldRecommendations: z.array(FieldRecommendationSchema).max(72).default([]),
  identityRequirements: PolicyIdentitySchema.optional(),
  codeAdapterNeeded: CodeAdapterNeedSchema.optional(),
});
export type InvestigationResult = z.infer<typeof InvestigationResultSchema>;

/** Immutable input snapshot persisted with every investigation. */
export const InvestigationInputSnapshotSchema = z.object({
  domain: z.string().min(1),
  mode: InvestigationModeSchema,
  sampleUrls: z.array(z.string().url()).min(1).max(5),
  budget: InvestigationBudgetSchema,
  modelPolicy: InvestigationModelPolicySchema,
  knownContext: z.record(z.string(), z.unknown()).default({}),
  requestedAt: z.string().min(1),
});
export type InvestigationInputSnapshot = z.infer<typeof InvestigationInputSnapshotSchema>;

export const InvestigationRecordSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  domain: z.string().min(1),
  mode: InvestigationModeSchema,
  status: InvestigationStatusSchema,
  provider: InvestigationProviderIdSchema,
  runId: z.string().min(1),
  requestedModel: InvestigationModelMetadataSchema.nullable().default(null),
  actualModel: InvestigationModelMetadataSchema.nullable().default(null),
  inputSnapshot: InvestigationInputSnapshotSchema,
  inputHash: z.string().min(8),
  budget: InvestigationBudgetSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  usage: InvestigationUsageSchema.nullable().default(null),
  failureCode: InvestigationFailureCodeSchema.nullable().default(null),
  /** Operator-safe failure detail. Never secrets, prompts, or raw page content. */
  failureDetail: z.string().max(2000).nullable().default(null),
  /** Untrusted typed result. Present only on `completed`. */
  result: InvestigationResultSchema.nullable().default(null),
  resultHash: z.string().nullable().default(null),
  discardedAt: z.string().nullable().default(null),
  discardActor: z.string().nullable().default(null),
});
export type InvestigationRecord = z.infer<typeof InvestigationRecordSchema>;

export function normalizeInvestigationDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '').trim();
}
