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

/** Providers known to the T1 seam. `cloud` is intentionally absent: requesting
 * it must fail closed with `cloud_disabled` and no Cloud SDK ships in T1. */
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
]);
export type InvestigationFailureCode = z.infer<typeof InvestigationFailureCodeSchema>;

export const DEFAULT_INVESTIGATION_BUDGET = {
  maxPages: 5,
  maxReads: 20,
  maxModelCalls: 8,
  timeoutMs: 10 * 60 * 1000,
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
});
export type InvestigationBudget = z.infer<typeof InvestigationBudgetSchema>;

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
});
export type InvestigationUsage = z.infer<typeof InvestigationUsageSchema>;

/** One untrusted, source-attributed observation. Evidence, not proof. */
export const InvestigationObservationSchema = z.object({
  kind: z.string().min(1).max(120),
  sourceUrl: z.string().url(),
  /** Hash of the captured artifact bytes (hex). Prefix hashes must not
   * masquerade as full-content hashes — producers record full hashes only. */
  artifactHash: z.string().min(8).max(128),
  detail: z.string().max(4000).optional(),
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
