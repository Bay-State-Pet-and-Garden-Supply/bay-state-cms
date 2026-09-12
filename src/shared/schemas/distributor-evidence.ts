import { z } from 'zod';
import { isCanonicalDeclaredAxis } from './variant-axes';

// ─── Product Identity Evidence ─────────────────────────────────────────────────

export const ProductIdentityEvidenceSchema = z.object({
  upc: z.string().optional(),
  gtin: z.string().optional(),
  /** The product's real barcode when it differs from the matched identifier
   * (item-number matches carry the PDP's actual UPC/EA, Amendment B). */
  distributorUpc: z.string().optional(),
  distributorSku: z.string().optional(),
  manufacturerPartNumber: z.string().optional(),
  name: z.string().optional(),
  brand: z.string().optional(),
  /** Issue #106: connector-side brand-candidate provenance (observed-null when unknown). */
  brandSource: z.string().max(64).nullish(),
  description: z.string().optional(),
  weight: z.string().optional(),
  /** Amendment B (M2): explicit bounded merchandising fields. */
  features: z.array(z.string().max(2000)).max(50).optional(),
  category: z.string().max(2000).optional(),
  dimensions: z.string().max(2000).optional(),
  casePack: z.string().max(2000).optional(),
  unitOfMeasure: z.string().max(2000).optional(),
  ingredients: z.string().max(2000).optional(),
  attributes: z.record(z.string(), z.string()).optional(),
  images: z.array(z.string()).optional(),
  /**
   * Amendment A: connector-declared variant axes for the generation that
   * produced this evidence. Bounded, normalized names (see
   * `normalizeDeclaredVariantAxis`). An attribute key that is neither a
   * built-in axis nor declared here makes the record INSUFFICIENT for
   * Discovery-skipping qualification.
   */
  declaredVariantAxes: z.array(z.string().min(1).max(64)).max(64).optional(),
});

export type ProductIdentityEvidence = z.infer<typeof ProductIdentityEvidenceSchema>;

// ─── Evidence Lookup Outcome ──────────────────────────────────────────────────

export const EvidenceLookupOutcomeEnum = z.enum([
  'found',
  'not_stocked',
  'source_error',
]);

export type EvidenceLookupOutcome = z.infer<typeof EvidenceLookupOutcomeEnum>;
// ─── Product Evidence Lookup Result ────────────────────────────────────────────

export const ProductEvidenceLookupResultSchema = z.object({
  providerId: z.string(),
  providerType: z.literal('distributor'),
  outcome: EvidenceLookupOutcomeEnum,
  confidence: z.number().min(0).max(1),
  identity: ProductIdentityEvidenceSchema,
  evidenceUrl: z.string().nullable(),
  matchedFields: z.array(z.string()),
  warnings: z.array(z.string()),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  /**
   * ADR 0014: raw provider snapshots are NOT part of any contract. Only
   * normalized identity evidence may be persisted; raw payloads are never
   * authoritative and never stored.
   */
});


export type ProductEvidenceLookupResult = z.infer<typeof ProductEvidenceLookupResultSchema>;

// ─── Distributor Evidence Attempt (persisted row) ──────────────────────────────

/**
 * Persisted evidence attempt. Immutable and generation-scoped (ADR 0014):
 * every row carries the sourcing generation it belongs to, and only the
 * current generation may influence reconciliation, acceptance, conflict
 * completion, or routing.
 */
export const EvidenceAttemptSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  providerId: z.string(),
  distributorConnectionId: z.string().nullable().optional(),
  catalogSnapshotId: z.string().nullable().optional(),
  lookupUpc: z.string(),
  outcome: EvidenceLookupOutcomeEnum,
  confidence: z.number().min(0).max(1),
  evidenceUrl: z.string().nullable(),
  matchedFields: z.array(z.string()),
  identityJson: z.string().nullable(),
  warningsJson: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  catalogVersion: z.string().nullable().optional(),
  /** Strict observation provenance: must be a valid ISO timestamp when present. */
  observedAt: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), 'observedAt must be a valid timestamp')
    .optional(),
  expiresAt: z.string().nullable().optional(),
  /**
   * Immutable sourcing generation this attempt belongs to (ADR 0014).
   * Nullable: legacy/ambiguous migrated rows carry no generation binding.
   */
  sourcingGenerationId: z.string().nullable().optional(),
  /** Amendment A: connector observation duration ms (≥0) for measured p95 / source-error gates. */
  durationMs: z.number().int().min(0).optional(),
  /**
   * Amendment A: connector-declared raw-field → normalized-axis declarations
   * observed during this attempt. Normalized, unique per axis, bounded.
   */
  variantAxisDeclarations: z
    .array(
      z.object({
        rawField: z.string().min(1).max(256),
        normalizedAxis: z
          .string()
          .min(1)
          .max(64)
          .refine(isCanonicalDeclaredAxis, 'normalizedAxis must be canonical'),
      }),
    )
    .max(16)
    .refine(
      (decls) => new Set(decls.map((d) => d.normalizedAxis)).size === decls.length,
      'variantAxisDeclarations must be unique by normalizedAxis',
    )
    .optional(),
  createdAt: z.string(),
});


export type EvidenceAttempt = z.infer<typeof EvidenceAttemptSchema>;

// ─── Insert type for the repository layer ──────────────────────────────────────

/**
 * The single evidence writer input (ADR 0014): validates ownership before
 * insert, appends exactly once, and never updates prior attempts. No raw
 * payloads or credentials are ever part of this contract.
 */
export interface InsertEvidenceAttempt {
  itemId: string;
  providerId: string;
  distributorConnectionId?: string | null;
  catalogSnapshotId?: string | null;
  lookupUpc: string;
  outcome: EvidenceLookupOutcome;
  confidence: number;
  evidenceUrl: string | null;
  matchedFields: string[];
  identityJson: string | null;
  warningsJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  catalogVersion?: string | null;
  observedAt?: string | null;
  expiresAt?: string | null;
  sourcingGenerationId?: string | null;
  /** Amendment A: connector observation duration ms (≥0) for measured gates. */
  durationMs?: number;
  /**
   * Amendment A: connector-declared raw-field → normalized-axis declarations
   * observed during this attempt (typed first-class; no type-cast escape
   * hatch in the repository). Bounded, unique by normalized axis.
   */
  variantAxisDeclarations?: EvidenceAttempt['variantAxisDeclarations'];
}
