import { z } from 'zod';

/**
 * Distributor entity, connection, and evidence-authority schemas.
 *
 * Recovered from the multi-distributor "V2" work (stash@{1} / dc01ea6) and
 * adapted per ADR 0014:
 *
 * - `connectorType` is CLOSED to `api | ftp_catalog | csv | html_scraper | legacy_adapter`
 *   (`html_scraper` added by ADR 0014 Amendment B: Distributor Scraper
 *   connectors that extract catalog data from web storefronts via
 *   authenticated sessions).
 * - Raw credentials are forbidden anywhere in connection configuration
 *   (recursive, case-insensitive key AND value/URL rejection); only
 *   `secretRef` references a server-side secret.
 * - Authority policy is NARROWED to v1 identity fields: commerce
 *   price/inventory authority is deferred (not granted by ADR 0014).
 * - Brand strategy configuration is mapping-only: officialDomains drive binding.
 *   Distributor connections are queried query-all in repository order; there is
 *   no preference ordering, filtering, or fall-open brand profile.
 */

// ─── Distributor Entity ────────────────────────────────────────────────────────

export const DistributorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(['active', 'inactive', 'deprecated']).default('active'),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Distributor = z.infer<typeof DistributorSchema>;

export const InsertDistributorSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  status: z.enum(['active', 'inactive', 'deprecated']).optional().default('active'),
});

export type InsertDistributor = z.input<typeof InsertDistributorSchema>;

// ─── Distributor Authority Policy (narrowed per ADR 0014) ─────────────────────

/**
 * v1 Sourcing uses IDENTITY fields only. The recovered V2 policy carried
 * pricingAuthority / inventoryAuthority / copyContributionMode — commerce
 * authority is NOT granted by ADR 0014 and those fields are deferred until a
 * future ADR. `skuAuthority` remains because the distributor SKU is identity
 * evidence (part of the exact-identifier match contract).
 */
export const DistributorAuthorityPolicySchema = z
  .object({
    skuAuthority: z.boolean().default(true),
    identityFieldOverrides: z.array(z.string()).default([]),
  })
  .default({
    skuAuthority: true,
    identityFieldOverrides: [],
  });

export type DistributorAuthorityPolicy = z.infer<typeof DistributorAuthorityPolicySchema>;

// ─── Distributor Connection ────────────────────────────────────────────────────

const CREDENTIAL_SHAPED_KEYS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'clientsecret',
  'client_secret',
  'api_key',
  'apikey',
  'token',
  'auth_token',
  'accesstoken',
  'access_token',
  'refresh_token',
  'private_key',
  'privatekey',
  'authorization',
  'x-api-key',
];

/** Credential-bearing string values (URLs with userinfo, PEM blocks, assignments). */
const CREDENTIAL_VALUE_PATTERNS = [
  /:\/\/[^/@\s]+:[^/@\s]+@/, // https://user:pass@host
  /:\/\/[^/@\s]+@/, // https://token@host (single-component userinfo)
  /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/,
  /^Bearer\s+/i, // Authorization: Bearer <token>
  /^Basic\s+/i, // Authorization: Basic <base64>
  /password\s*=/i,
  /api[_-]?key\s*=/i,
  /token\s*=/i,
  /secret\s*=/i,
  /authorization\s*:/i,
];

/**
 * Recursive, case-insensitive rejection of credential-shaped keys AND
 * credential-bearing values/URLs anywhere in the configuration tree.
 * Only non-secret configuration (base URLs, paths, field maps) may be stored;
 * anything else must go through `secretRef`.
 */
function assertNoCredentials(data: unknown, ctx: z.RefinementCtx, path: Array<string | number> = []): void {
  if (data === null || data === undefined) return;
  if (typeof data === 'string') {
    for (const pattern of CREDENTIAL_VALUE_PATTERNS) {
      if (pattern.test(data)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Credential-shaped value at '${path.join('.')}' is forbidden in configuration. Use secretRef instead.`,
          path: [...path],
        });
        return;
      }
    }
    return;
  }
  if (typeof data === 'object') {
    for (const [key, value] of Object.entries(data)) {
      const normalizedKey = key.toLowerCase();
      if (CREDENTIAL_SHAPED_KEYS.some((k) => normalizedKey === k || normalizedKey.includes(k))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Raw credential key '${key}' is forbidden in configuration. Use secretRef instead.`,
          path: [...path, key],
        });
        continue;
      }
      assertNoCredentials(value, ctx, [...path, key]);
    }
  }
}

/**
 * Security bound: raw secrets/passwords are forbidden inside configuration —
 * recursively, case-insensitively, including credential-shaped values and
 * userinfo URLs. Use `secretRef` to reference an env var or api_keys service.
 */
export const DistributorConnectionConfigurationSchema = z
  .record(z.string(), z.unknown())
  .superRefine((data, ctx) => {
    assertNoCredentials(data, ctx);
  });

export const DistributorConnectorTypeEnum = z.enum(['api', 'ftp_catalog', 'csv', 'html_scraper', 'legacy_adapter']);
export type DistributorConnectorType = z.infer<typeof DistributorConnectorTypeEnum>;

/**
 * Secret-reference-only syntax (ADR 0014): a `secret_ref` is an OPAQUE
 * reference name — an env var name or an api_keys service name — never a
 * credential value. Identifier characters only; credential-shaped strings
 * (whitespace, '=', '/', ':', long base62 runs, 'sk-' prefixes) are
 * rejected so an operator cannot paste a raw key into the reference.
 */
export const SecretRefSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, 'secretRef must be a reference name (env var or api_keys service), never a credential value')
  .refine((v) => !/^[A-Za-z0-9]{24,}$/.test(v), 'secretRef looks like a raw credential value; reference a secret by name instead')
  .refine((v) => !/^sk-|^pk-|^ak-|^api[-_]?key/i.test(v), 'secretRef looks like a raw credential value; reference a secret by name instead');

export const DistributorConnectionSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  distributorId: z.string().min(1),
  connectorType: DistributorConnectorTypeEnum,
  /** Secret reference identifier (e.g. env var name or api_keys service name) */
  secretRef: SecretRefSchema.nullable().optional().default(null),
  configuration: DistributorConnectionConfigurationSchema.default({}),
  authorityPolicy: DistributorAuthorityPolicySchema.default({
    skuAuthority: true,
    identityFieldOverrides: [],
  }),
  enabled: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type DistributorConnection = z.infer<typeof DistributorConnectionSchema>;

/**
 * Create input. Amendment A (default-on): NEW connections default to
 * DISABLED — an operator must explicitly enable through a workspace-scoped
 * update after provisioning and health checks (Milestone C UI). An omitted
 * `enabled` yields `false`; the repository writer additionally fails closed
 * on create-as-enabled shortcuts.
 */
export const InsertDistributorConnectionSchema = z.object({
  workspaceId: z.string().min(1),
  distributorId: z.string().min(1),
  connectorType: DistributorConnectorTypeEnum,
  secretRef: SecretRefSchema.nullable().optional().default(null),
  configuration: DistributorConnectionConfigurationSchema.optional().default({}),
  authorityPolicy: DistributorAuthorityPolicySchema.optional().default({
    skuAuthority: true,
    identityFieldOverrides: [],
  }),
  /**
   * Amendment A: creation is ALWAYS disabled. Enablement happens only
   * through a separate workspace-scoped update after operator health checks.
   * An explicit `enabled: true` on create is a schema violation.
   */
  enabled: z.literal(false).optional(),
});

export type InsertDistributorConnection = z.input<typeof InsertDistributorConnectionSchema>;

/** Update shape: every field optional, validated identically to create. */
export const UpdateDistributorConnectionSchema = z
  .object({
    connectorType: DistributorConnectorTypeEnum.optional(),
    secretRef: SecretRefSchema.nullable().optional(),
    configuration: DistributorConnectionConfigurationSchema.optional(),
    authorityPolicy: DistributorAuthorityPolicySchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type UpdateDistributorConnection = z.infer<typeof UpdateDistributorConnectionSchema>;

// ─── Distributor Catalog Snapshot ─────────────────────────────────────────────

export const DistributorCatalogSnapshotSchema = z.object({
  id: z.string().min(1),
  distributorConnectionId: z.string().min(1),
  externalVersion: z.string().nullable().default(null),
  contentHash: z.string().nullable().default(null),
  observedAt: z.string(),
  completedAt: z.string().nullable().default(null),
  expiresAt: z.string().nullable().default(null),
  status: z.enum(['active', 'stale', 'invalidated']).default('active'),
  createdAt: z.string(),
});

export type DistributorCatalogSnapshot = z.infer<typeof DistributorCatalogSnapshotSchema>;

// ─── Onboarding Evidence Conflict & Candidate ──────────────────────────────────

export const ConflictSeverityEnum = z.enum(['hard', 'soft']);
export type ConflictSeverity = z.infer<typeof ConflictSeverityEnum>;

export const ConflictStatusEnum = z.enum(['open', 'resolved', 'dismissed']);
export type ConflictStatus = z.infer<typeof ConflictStatusEnum>;

export const OnboardingEvidenceConflictCandidateSchema = z.object({
  id: z.string().min(1),
  conflictId: z.string().min(1),
  evidenceAttemptId: z.string().min(1),
  valueJson: z.string(),
  createdAt: z.string(),
});

export type OnboardingEvidenceConflictCandidate = z.infer<typeof OnboardingEvidenceConflictCandidateSchema>;

export const OnboardingEvidenceConflictSchema = z.object({
  id: z.string().min(1),
  itemId: z.string().min(1),
  field: z.string().min(1),
  severity: ConflictSeverityEnum,
  status: ConflictStatusEnum,
  /** Immutable sourcing generation this conflict belongs to (ADR 0014); null for legacy rows. */
  sourcingGenerationId: z.string().nullable().optional().default(null),
  resolutionType: z.enum(['candidate_selected', 'custom_override', 'dismissed']).nullable().default(null),
  resolvedValue: z.string().nullable().default(null),
  resolvedBy: z.string().nullable().default(null),
  resolvedAt: z.string().nullable().default(null),
  candidates: z.array(OnboardingEvidenceConflictCandidateSchema).default(() => []),
  createdAt: z.string(),
});

export type OnboardingEvidenceConflict = z.infer<typeof OnboardingEvidenceConflictSchema>;

export const ResolveConflictRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('resolve_candidate'),
    candidateId: z.string().min(1),
  }),
  z.object({
    action: z.literal('custom_value'),
    customValue: z.string().min(1),
  }),
  z.object({
    action: z.literal('dismiss'),
  }),
]);

export type ResolveConflictRequest = z.infer<typeof ResolveConflictRequestSchema>;

// ─── Onboarding Item Evidence Acceptance ───────────────────────────────────────

export const OnboardingItemEvidenceAcceptanceSchema = z.object({
  id: z.string().min(1),
  itemId: z.string().min(1),
  evidenceAttemptId: z.string().min(1),
  acceptedBy: z.string().default('system'),
  acceptedAt: z.string(),
  reason: z.string().nullable().default(null),
  createdAt: z.string(),
});

export type OnboardingItemEvidenceAcceptance = z.infer<typeof OnboardingItemEvidenceAcceptanceSchema>;
