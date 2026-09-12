import { z } from 'zod';

export const BrandStrategySitemapSchema = z.object({
  totalUrls: z.number().int().min(0),
  freshCount: z.number().int().min(0),
  lastRefreshAt: z.string().nullable(),
  freshness: z.enum(['fresh', 'stale', 'missing']),
});

export const BrandStrategyOfficialDomainSchema = z.object({
  domain: z.string().min(1),
  sitemap: BrandStrategySitemapSchema,
});

export const BrandStrategyDiagnosticSchema = z.object({
  candidateBrand: z.string().min(1),
  reason: z.string().min(1),
});

// Spec #120 — operator-approved reusable per-brand collection plan.
// A strategy names legitimate sources; an official website is optional.
// Approval authorizes collection within existing authority rules only:
// it never changes credentials, source authority classification, claim
// permissions, or image rights.
export const StrategySourceKindSchema = z.enum(['official_page', 'distributor_record']);
export type StrategySourceKind = z.infer<typeof StrategySourceKindSchema>;

export const StrategySourceRefSchema = z.object({
  kind: StrategySourceKindSchema,
  /** Distributor id for distributor_record sources. */
  distributorId: z.string().min(1).optional(),
  /** Lowercase domain for official_page sources. */
  domain: z.string().min(1).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.kind === 'distributor_record' && !v.distributorId) {
    ctx.addIssue({ code: 'custom', message: 'distributor_record sources require distributorId' });
  }
  if (v.kind === 'official_page' && !v.domain) {
    ctx.addIssue({ code: 'custom', message: 'official_page sources require domain' });
  }
});
export type StrategySourceRef = z.infer<typeof StrategySourceRefSchema>;

export const StrategyConfigurationSchema = z.object({
  /** Complete replacement of this brand's editable official-domain set. */
  officialDomains: z.array(z.string().min(1).max(253)).max(25),
}).strict();
export type StrategyConfiguration = z.infer<typeof StrategyConfigurationSchema>;

export const ApproveBrandStrategySchema = z.object({
  // Trimmed: whitespace-only brands must fail closed as 400, never persist
  // an empty normalized identity (review-loop R1 P0-1).
  brand: z.string().trim().min(1).max(128),
  sources: z.array(StrategySourceRefSchema).min(1).max(25),
  /**
   * Optimistic-concurrency guard (REQUIRED since builder Amendment B1):
   * 0 matches only the absent-row case. Missing guard is 400, never an
   * unguarded write. Every accepted explicit Save creates one revision.
   */
  expectedRevision: z.number().int().min(0),
  /**
   * Optional complete configuration replacement applied atomically with the
   * approval. When present, `expectedConfigurationToken` is required.
   */
  configuration: StrategyConfigurationSchema.optional(),
  expectedConfigurationToken: z.string().min(1).max(256).optional(),
  approvedBy: z.string().min(1).max(128).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.configuration !== undefined && !v.expectedConfigurationToken) {
    ctx.addIssue({ code: 'custom', message: 'configuration saves require expectedConfigurationToken' });
  }
});
export type ApproveBrandStrategy = z.infer<typeof ApproveBrandStrategySchema>;

export const ApprovedBrandStrategySchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  brand: z.string().min(1),
  normalizedBrand: z.string().min(1),
  sources: z.array(StrategySourceRefSchema),
  revision: z.number().int().min(1),
  approved: z.boolean(),
  approvedAt: z.string().nullable(),
  approvedBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ApprovedBrandStrategy = z.infer<typeof ApprovedBrandStrategySchema>;

export const BrandStrategyApprovalStateSchema = z.object({
  approved: z.boolean(),
  revision: z.number().int().min(0),
  approvedAt: z.string().nullable(),
  approvedBy: z.string().nullable(),
});
export type BrandStrategyApprovalState = z.infer<typeof BrandStrategyApprovalStateSchema>;

export const BrandStrategySourceAvailabilitySchema = z.object({
  kind: StrategySourceKindSchema,
  /** Distributor id or domain, matching the source ref. */
  ref: z.string().min(1),
  available: z.boolean(),
  /** Bounded machine-readable reason (never secrets or raw errors). */
  reason: z.enum([
    'ready',
    'no_profile',
    'profile_not_healthy',
    'connection_disabled',
    'connection_not_configured',
    // Ticket #125: engine-parity usability (registry support + secrets).
    'connector_not_supported',
    'credentials_missing',
    'not_approved',
    // No collection path executes this source yet (e.g. official_page
    // inside an approved strategy). Reported, never silently dropped.
    'not_supported',
    'unknown',
  ]),
});
export type BrandStrategySourceAvailability = z.infer<typeof BrandStrategySourceAvailabilitySchema>;

export const BrandStrategyCollectionReadinessSchema = z.enum([
  'awaiting_approval',
  'setup_attention',
  'ready',
  'ready_partial',
  'unknown',
]);
export type BrandStrategyCollectionReadiness = z.infer<typeof BrandStrategyCollectionReadinessSchema>;

export const BrandStrategySourceOptionSchema = z.object({
  kind: StrategySourceKindSchema,
  /** Distributor id or canonical domain. */
  ref: z.string().min(1).max(253),
  /** Human-readable label (never a credential or raw error). */
  displayName: z.string().min(1).max(253),
  /** False for retained-but-unrepairable refs (visible, not selectable). */
  selectable: z.boolean(),
  /** Bounded machine-readable selectability/setup reason. */
  reason: z.string().min(1).max(64),
  /** Current point-in-time setup availability (not proof of stock). */
  available: z.boolean(),
});
export type BrandStrategySourceOption = z.infer<typeof BrandStrategySourceOptionSchema>;

export const BrandStrategyExecutionAvailabilitySchema = z.object({
  enabled: z.boolean(),
  reason: z.string().min(1).max(64),
});
export type BrandStrategyExecutionAvailability = z.infer<typeof BrandStrategyExecutionAvailabilitySchema>;

export const BrandStrategySchema = z.object({
  brandKey: z.string().min(1),
  normalizedBrand: z.string().min(1),
  officialDomains: z.array(BrandStrategyOfficialDomainSchema),
  /** Canonical server-derived live proposal (query-all source options). */
  proposalSources: z.array(StrategySourceRefSchema).optional(),
  /** Selectable/visible source catalog for the builder. */
  sourceOptions: z.array(BrandStrategySourceOptionSchema).optional(),
  /** Guard token for mapping-only edits (absent-profile set is deterministic). */
  configurationToken: z.string().min(1).max(256).optional(),
  /** Effective sourcing capability (separate from approval). */
  executionAvailability: BrandStrategyExecutionAvailabilitySchema.optional(),
  extractorReadiness: z.enum(['active', 'degraded', 'draft', 'needs_testing', 'not_configured', 'profile_bypass_eligible']),
  ambiguous: z.array(BrandStrategyDiagnosticSchema),
  unmatched: z.boolean(),
  possibleMatches: z.array(BrandStrategyDiagnosticSchema),
  // Spec #120 (additive, optional for backward compatibility):
  // operator approval state + per-source availability reasons.
  // approvedSources is the stored approved boundary (distinct from the
  // live proposal in officialDomains/enabled connections); absent
  // means no stored boundary (legacy rows) — never infer approval.
  approval: BrandStrategyApprovalStateSchema.optional(),
  approvedSources: z.array(StrategySourceRefSchema).optional(),
  sourceAvailability: z.array(BrandStrategySourceAvailabilitySchema).optional(),
  collectionReadiness: BrandStrategyCollectionReadinessSchema.optional(),
});

export type BrandStrategy = z.infer<typeof BrandStrategySchema>;
export type BrandStrategySitemap = z.infer<typeof BrandStrategySitemapSchema>;
export type BrandStrategyOfficialDomain = z.infer<typeof BrandStrategyOfficialDomainSchema>;
