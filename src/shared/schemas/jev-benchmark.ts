import { z } from 'zod';
import { validateUrl } from '../../crawler/url-policy.js';

/** Numeric replay limits must be finite; NaN/infinity never disable a guard. */
export const JevReplayBudgetSchema = z.object({
  maxHttpAttempts: z.number().int().nonnegative().safe(),
  maxConcurrency: z.number().int().positive().safe(),
  hardDeadlineMs: z.number().int().positive().max(2_147_483_647),
}).strict();

/**
 * Representative Jev benchmark (#302 steps 2/3): source-candidate + manifest
 * schemas. Allowlisted public inputs only — no prices, customer data,
 * credentials, auth/query secrets, gold labels, or input snapshots.
 */

/** Fields that must never appear at ANY depth of a source-candidate export. */
export const FORBIDDEN_SOURCE_FIELDS = [
  'price',
  'salePrice',
  'sale_price',
  'customer',
  'password',
  'credential',
  'token',
  'auth',
  'authToken',
  'apiKey',
  'api_key',
  'access_token',
  'cookie',
  'sessionId',
  'goldLabels',
  'gold_labels_json',
  'goldState',
  'productTypeState',
  'fieldStates',
  'inputSnapshot',
  'input_snapshot_json',
  'reviewedFact',
  'vlmCredential',
  'modelPrediction',
  'adjudicatedBy',
  'labeler',
  'label',
] as const;

const Hex64Schema = z.string().regex(/^[0-9a-f]{64}$/, 'expected 64-char hex hash');

/** Query keys that must never ride on a source URL (auth/session/hash secrets). */
const SECRET_URL_PARAMS = [
  'token',
  'auth',
  'key',
  'api_key',
  'apikey',
  'access_token',
  'password',
  'secret',
  'signature',
  'sig',
  'session',
  'sessionid',
  'hash',
] as const;

/**
 * Public manufacturer URL gate: reuses the shared crawler host policy
 * (no userinfo, no IP/private/localhost/lan/metadata targets, no bad ports)
 * plus benchmark-strict rules — https only, no secret query params.
 */
export function assertPublicSourceUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('invalid_source_url: not a URL');
  }
  if (parsed.protocol !== 'https:') throw new Error('invalid_source_url: canonical URL must be https');
  const policy = validateUrl(url);
  if (!policy.ok) {
    throw new Error(`invalid_source_url: ${policy.issues.join(',')}`);
  }
  const params = parsed.searchParams;
  for (const key of SECRET_URL_PARAMS) {
    if (params.has(key)) throw new Error(`invalid_source_url: query carries "${key}"`);
  }
  return policy.canonicalUrl ?? url;
}

const PublicSourceUrlSchema = z.string().refine(
  (url: string) => {
    try {
      assertPublicSourceUrl(url);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'canonical URL must be a public https manufacturer URL without credentials or secrets' },
);

export const JevSourceExcerptSchema = z
  .object({
    text: z.string().min(1).max(2000),
    locator: z.string().min(1).max(500),
  })
  .strict();

/** Allowlisted public source-candidate export row (labeler INPUT, never a label). */
export const JevSourceCandidateSchema = z
  .object({
    sku: z.string().min(1).max(120),
    title: z.string().min(1).max(500),
    brand: z.string().min(1).max(200),
    canonicalUrl: PublicSourceUrlSchema,
    productIdentity: z.string().min(1).max(300),
    sourceLocator: z.string().min(1).max(500),
    sourceHash: Hex64Schema,
    retrievedAt: z.string().datetime(),
    familyId: z.string().min(1).max(200),
    excerpts: z.array(JevSourceExcerptSchema).min(1).max(20),
    evidenceLimitations: z.string().max(2000).optional(),
  })
  .strict();

export type JevSourceCandidate = z.infer<typeof JevSourceCandidateSchema>;

export const JevAuthorityBindingSchema = z
  .object({
    workspaceId: z.string().uuid(),
    release: z.string().min(1),
    catalogGitCommit: z.string().regex(/^[0-9a-f]{8,40}$/),
    configHash: Hex64Schema,
    capturedAt: z.string().datetime(),
    pageImportId: z.string().min(1),
    pageImportHash: Hex64Schema,
    verifiedPageCount: z.number().int().nonnegative(),
  })
  .strict();

export type JevAuthorityBinding = z.infer<typeof JevAuthorityBindingSchema>;

export const JevManifestEntrySchema = z
  .object({
    sku: z.string().min(1),
    familyId: z.string().min(1),
    splitGroup: z.enum(['train', 'test', 'holdout']),
    sourceHash: Hex64Schema,
    canonicalUrl: PublicSourceUrlSchema,
  })
  .strict();

export type JevManifestEntry = z.infer<typeof JevManifestEntrySchema>;

/** Holdout custody is commit-hashes + metadata only — never row-to-label maps. */
export const JevHoldoutCustodySchema = z
  .object({
    holdoutCommitHash: Hex64Schema.nullable(),
    holdoutExampleCount: z.number().int().nonnegative(),
    holdoutFamilyCount: z.number().int().nonnegative(),
    custodian: z.string().min(1).max(200),
    sealedAt: z.string().datetime(),
  })
  .strict();

export type JevHoldoutCustody = z.infer<typeof JevHoldoutCustodySchema>;

export const JevDryRunSummarySchema = z
  .object({
    dryRun: z.literal(true),
    workspaceId: z.string().uuid(),
    authorityHash: Hex64Schema,
    candidateCount: z.number().int().nonnegative(),
    familyCount: z.number().int().nonnegative(),
    splitDistribution: z.object({
      train: z.number().int().nonnegative(),
      test: z.number().int().nonnegative(),
      holdout: z.number().int().nonnegative(),
    }),
    writes: z.literal(0),
  })
  .strict();

export type JevDryRunSummary = z.infer<typeof JevDryRunSummarySchema>;

/**
 * Explicit-write accounting (additive; JevDryRunSummary stays pure for
 * preflight). `dryRun: false` + `filesWritten` record the actual
 * filesystem outputs; `dbWrites` remains 0 — database/routing writes never
 * happen in either mode.
 */
export const JevWriteResultSchema = z
  .object({
    dryRun: z.literal(false),
    workspaceId: z.string().uuid(),
    authorityHash: Hex64Schema,
    candidateCount: z.number().int().nonnegative(),
    familyCount: z.number().int().nonnegative(),
    splitDistribution: z.object({
      train: z.number().int().nonnegative(),
      test: z.number().int().nonnegative(),
      holdout: z.number().int().nonnegative(),
    }),
    dbWrites: z.literal(0),
    filesWritten: z.number().int().nonnegative(),
    outDir: z.string().min(1),
  })
  .strict();

export type JevWriteResult = z.infer<typeof JevWriteResultSchema>;

/**
 * Deep scan for forbidden keys: rejects gold/provenance smuggling nested
 * inside excerpts or any sub-object, not just top-level keys.
 */
export function findForbiddenSourceFields(candidate: unknown, seen = new Set<unknown>()): string[] {
  if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) return [];
  const found = new Set<string>();
  const forbidden = new Set<string>(FORBIDDEN_SOURCE_FIELDS as readonly string[]);
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    if (Array.isArray(value)) {
      seen.add(value);
      for (const item of value) visit(item);
      return;
    }
    seen.add(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (forbidden.has(key)) found.add(key);
      visit((value as Record<string, unknown>)[key]);
    }
  };
  visit(candidate);
  return [...found];
}

export function parseSourceCandidateExport(candidate: unknown): JevSourceCandidate {
  const forbidden = findForbiddenSourceFields(candidate);
  if (forbidden.length > 0) {
    throw new Error(`forbidden_source_field: ${forbidden.join(', ')}`);
  }
  return JevSourceCandidateSchema.parse(candidate);
}
