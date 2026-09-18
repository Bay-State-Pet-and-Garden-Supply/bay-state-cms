import { z } from 'zod';
import { sha256 } from '../hash';

export const VARIANT_PARSER_VERSION = 1;
export const MAX_NORMALIZED_VARIANTS = 250;

export const VariantPlatformSchema = z.enum([
  'shopify',
  'jsonld',
  'woocommerce',
  'bigcommerce',
  'magento',
  'unknown',
]);
export type VariantPlatform = z.infer<typeof VariantPlatformSchema>;

export const VariantIdentifierKindSchema = z.enum(['gtin', 'sku', 'mpn', 'platform_id']);
export type VariantIdentifierKind = z.infer<typeof VariantIdentifierKindSchema>;

export const VariantIdentifierSchema = z.object({
  kind: VariantIdentifierKindSchema,
  value: z.string().min(1).max(512),
  normalizedValue: z.string().min(1).max(512),
  sourcePath: z.string().min(1).max(512),
});
export type VariantIdentifier = z.infer<typeof VariantIdentifierSchema>;

export const VariantOptionSchema = z.object({
  axis: z.string().min(1).max(128),
  value: z.string().min(1).max(512),
  normalizedAxis: z.string().min(1).max(128),
  normalizedValue: z.string().min(1).max(512),
  sourcePath: z.string().min(1).max(512),
});
export type VariantOption = z.infer<typeof VariantOptionSchema>;

export const VariantImageSchema = z.object({
  url: z.string().min(1).max(2048),
  role: z.enum(['primary', 'gallery']),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  sourcePath: z.string().min(1).max(512),
});
export type VariantImage = z.infer<typeof VariantImageSchema>;

export const NormalizedVariantCandidateSchema = z.object({
  variantKey: z.string().min(1).max(256),
  platformId: z.string().min(1).max(256).nullable(),
  title: z.string().min(1).max(512),
  identifiers: z.array(VariantIdentifierSchema).max(12),
  options: z.array(VariantOptionSchema).max(8),
  available: z.boolean(),
  price: z.string().max(64).nullable(),
  currency: z.string().max(8).nullable(),
  weight: z.string().max(64).nullable(),
  dimensions: z.string().max(128).nullable(),
  images: z.array(VariantImageSchema).max(32),
  deepLink: z.string().min(1).max(2048),
  sourcePaths: z.record(z.string(), z.string()),
});
export type NormalizedVariantCandidate = z.infer<typeof NormalizedVariantCandidateSchema>;

export const VariantMatrixSchema = z.object({
  parserVersion: z.number().int().min(1),
  platform: VariantPlatformSchema,
  canonicalParentUrl: z.string().min(1).max(2048),
  sourceFinalUrl: z.string().min(1).max(2048).nullable(),
  sourceContentHash: z.string().max(128).nullable(),
  candidates: z.array(NormalizedVariantCandidateSchema).max(MAX_NORMALIZED_VARIANTS),
  warnings: z.array(z.string().max(512)),
  createdAt: z.string().min(1),
});
export type VariantMatrix = z.infer<typeof VariantMatrixSchema>;

export const ExpectedOptionSchema = z.object({
  axis: z.string().min(1).max(128),
  value: z.string().min(1).max(512),
});
export type ExpectedOption = z.infer<typeof ExpectedOptionSchema>;

export const VariantMatchInputSchema = z.object({
  gtin: z.string().max(32).nullable().optional(),
  sku: z.string().max(512).nullable().optional(),
  mpn: z.string().max(512).nullable().optional(),
  name: z.string().min(1).max(512),
  brandHint: z.string().max(256).nullable().optional(),
  price: z.string().max(64).nullable().optional(),
  variantTokens: z.array(z.string().max(128)).max(32).optional(),
  expectedOptions: z.array(ExpectedOptionSchema).max(8).optional(),
  /**
   * Exact known platform variant ID (e.g. a Shopify variant ID observed on
   * a trusted source page). Compared ONLY against candidate variant IDs —
   * a parent product ID never equals a variant ID, so it can never select
   * among variants. Weaker than GTIN/SKU/MPN: any conflict with a stronger
   * identifier fails closed to ambiguity.
   */
  platformVariantId: z.string().max(256).nullable().optional(),
});
export type VariantMatchInput = z.infer<typeof VariantMatchInputSchema>;

export const VariantMatchDecisionStatusSchema = z.enum([
  'resolved',
  'ambiguous',
  'no_match',
  'unsupported',
  'too_many_variants',
  'stale_selection',
]);
export type VariantMatchDecisionStatus = z.infer<typeof VariantMatchDecisionStatusSchema>;

export const VariantMatchDecisionSchema = z.object({
  status: VariantMatchDecisionStatusSchema,
  selectedVariantKey: z.string().max(256).nullable(),
  reasonCodes: z.array(z.string().max(128)),
  matchedBy: z.enum(['gtin', 'sku', 'mpn', 'platform_id', 'options', 'ranked', 'none']),
  diagnostics: z.array(z.string().max(512)),
  rankedKeys: z.array(z.string().max(256)),
  score: z.number().min(0).max(1000).optional(),
  margin: z.number().min(0).max(1000).optional(),
});
export type VariantMatchDecision = z.infer<typeof VariantMatchDecisionSchema>;

export const HEX_64 = /^[a-f0-9]{64}$/;
export const VariantSelectionReceiptSchema = z.object({
  resolutionId: z.string().min(1).max(256),
  identityMatrixHash: z.string().regex(HEX_64),
  parserVersion: z.number().int().min(1),
  selectedVariantKey: z.string().min(1).max(256),
  decisionOrigin: z.enum(['automatic', 'operator']),
  selectedDeepLink: z.string().min(1).max(2048),
  matchedBy: z.string().max(64),
  evidencePaths: z.array(z.string().max(512)),
  createdAt: z.string().min(1),
});
export type VariantSelectionReceipt = z.infer<typeof VariantSelectionReceiptSchema>;

export const VariantResolutionSummarySchema = z.object({
  id: z.string().min(1),
  onboardingItemId: z.string().min(1),
  sourceUrl: z.string().min(1).max(2048),
  canonicalParentKey: z.string().min(1).max(2048),
  platform: VariantPlatformSchema,
  parserVersion: z.number().int().min(1),
  identityMatrixHash: z.string().regex(HEX_64),
  sourceContentHash: z.string().max(256).nullable(),
  status: z.enum(['resolved', 'ambiguous', 'no_match', 'unsupported', 'too_many_variants', 'selected', 'stale']),
  reasonCodes: z.array(z.string()),
  candidates: z.array(NormalizedVariantCandidateSchema),
  automaticVariantKey: z.string().nullable(),
  selectedVariantKey: z.string().nullable(),
  decisionOrigin: z.enum(['automatic', 'operator']).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type VariantResolutionSummary = z.infer<typeof VariantResolutionSummarySchema>;

export const VariantSelectionRequestSchema = z.object({
  resolutionId: z.string().min(1).max(256),
  identityMatrixHash: z.string().regex(HEX_64),
  variantKey: z.string().min(1).max(256),
});
export type VariantSelectionRequest = z.infer<typeof VariantSelectionRequestSchema>;

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function computeIdentityMatrixHash(matrix: VariantMatrix): string {
  const identityPart = {
    parserVersion: matrix.parserVersion,
    canonicalParentUrl: matrix.canonicalParentUrl,
    platform: matrix.platform,
    candidates: matrix.candidates
      .map((c) => ({
        variantKey: c.variantKey,
        platformId: c.platformId,
        identifiers: [...c.identifiers].sort((a, b) => a.kind.localeCompare(b.kind) || a.normalizedValue.localeCompare(b.normalizedValue)),
        options: [...c.options].sort((a, b) => a.normalizedAxis.localeCompare(b.normalizedAxis) || a.normalizedValue.localeCompare(b.normalizedValue)),
        deepLink: c.deepLink,
      }))
      .sort((a, b) => a.variantKey.localeCompare(b.variantKey)),
  };
  const json = stableStringify(identityPart);
  return sha256(json);
}
