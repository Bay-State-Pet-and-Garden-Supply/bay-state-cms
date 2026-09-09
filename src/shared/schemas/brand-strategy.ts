import { z } from 'zod';

export const SourcingPolicySchema = z.enum(['advisory', 'preferred_then_fallback', 'preferred_only']);

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

export const ApproveBrandStrategySchema = z.object({
  brand: z.string().min(1),
  sources: z.array(StrategySourceRefSchema).min(1).max(25),
  /** Optimistic-concurrency guard: reject when the stored revision differs. */
  expectedRevision: z.number().int().min(0).optional(),
  approvedBy: z.string().min(1).max(128).optional(),
}).strict();
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

export const BrandStrategySchema = z.object({
  brandKey: z.string().min(1),
  normalizedBrand: z.string().min(1),
  aliases: z.array(z.string()),
  preferredDistributorIds: z.array(z.string()),
  sourcingPolicy: SourcingPolicySchema,
  fallbackTier: z.array(z.string()),
  officialDomains: z.array(BrandStrategyOfficialDomainSchema),
  extractorReadiness: z.enum(['active', 'degraded', 'draft', 'needs_testing', 'not_configured', 'profile_bypass_eligible']),
  ambiguous: z.array(BrandStrategyDiagnosticSchema),
  unmatched: z.boolean(),
  possibleMatches: z.array(BrandStrategyDiagnosticSchema),
  // Spec #120 (additive, optional for backward compatibility):
  // operator approval state + per-source availability reasons.
  // approvedSources is the stored approved boundary (distinct from the
  // live proposal in preferredDistributorIds/officialDomains); absent
  // means no stored boundary (legacy rows) — never infer approval.
  approval: BrandStrategyApprovalStateSchema.optional(),
  approvedSources: z.array(StrategySourceRefSchema).optional(),
  sourceAvailability: z.array(BrandStrategySourceAvailabilitySchema).optional(),
  collectionReadiness: BrandStrategyCollectionReadinessSchema.optional(),
});

export type BrandStrategy = z.infer<typeof BrandStrategySchema>;
export type BrandStrategySitemap = z.infer<typeof BrandStrategySitemapSchema>;
export type BrandStrategyOfficialDomain = z.infer<typeof BrandStrategyOfficialDomainSchema>;
