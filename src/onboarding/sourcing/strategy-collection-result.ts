import { z } from 'zod';

/**
 * Spec #120 (tickets #122/#123): explicitly versioned multi-contribution
 * collection result consumed authoritatively by strategy-driven preparation.
 *
 * Each contribution keeps its own source typing (`official_page` vs
 * `distributor_record`); a mixed result is never dispatched, qualified, or
 * interpreted through a projected single-source flag. Legacy single-source
 * discriminators keep their meaning for historical rows. Unsupported result
 * versions fail closed. Distributor evidence is never relabeled as official.
 */
export const STRATEGY_COLLECTION_RESULT_VERSION = 'strategy-collection-v1' as const;

export const CollectionContributionSchema = z.object({
  kind: z.enum(['official_page', 'distributor_record']),
  /** Distributor connection id for distributor contributions. */
  connectionId: z.string().nullable().default(null),
  /** Provider id that supplied the contribution. */
  providerId: z.string().min(1),
  /** Evidence attempt ids backing this contribution. */
  attemptIds: z.array(z.string()),
  /** Official URL for official_page contributions; always null for distributor records. */
  sourceUrl: z.string().nullable().default(null),
  outcome: z.enum(['success', 'no_match', 'failed', 'unavailable']),
  /** Bounded machine-readable reason (never secrets or raw errors). */
  reasonCode: z.string().max(64).optional(),
  /** Merchandising fields this contribution supplies (attribution, not authority). */
  fields: z.record(z.string(), z.string()).default({}),
});

export type CollectionContribution = z.infer<typeof CollectionContributionSchema>;

export const StrategyCollectionResultSchema = z.object({
  version: z.literal(STRATEGY_COLLECTION_RESULT_VERSION),
  itemId: z.string().min(1),
  sourcingGenerationId: z.string().min(1),
  strategyRevision: z.number().int().min(1),
  strategyBrand: z.string().min(1),
  contributions: z.array(CollectionContributionSchema).min(1),
  /** Identity conflict stays upstream: never blend when true. */
  identityConflict: z.boolean().default(false),
});

export type StrategyCollectionResult = z.infer<typeof StrategyCollectionResultSchema>;

/**
 * Build a strategy collection result from per-source outcomes. Pure.
 * Fails closed (returns null) on an unsupported version request or when a
 * distributor contribution carries a source URL (never a fake official URL).
 */
export function buildStrategyCollectionResult(input: {
  itemId: string;
  sourcingGenerationId: string;
  strategyRevision: number;
  strategyBrand: string;
  contributions: CollectionContribution[];
  identityConflict?: boolean;
}): StrategyCollectionResult | null {
  if (!Number.isInteger(input.strategyRevision) || input.strategyRevision < 1) return null;
  if (input.contributions.length === 0) return null;
  for (const c of input.contributions) {
    if (c.kind === 'distributor_record' && c.sourceUrl !== null) return null;
    if (c.kind === 'official_page' && c.outcome === 'success' && !c.sourceUrl) return null;
  }
  const parsed = StrategyCollectionResultSchema.safeParse({
    version: STRATEGY_COLLECTION_RESULT_VERSION,
    itemId: input.itemId,
    sourcingGenerationId: input.sourcingGenerationId,
    strategyRevision: input.strategyRevision,
    strategyBrand: input.strategyBrand,
    contributions: input.contributions,
    identityConflict: input.identityConflict ?? false,
  });
  return parsed.success ? parsed.data : null;
}

/** Parse an unknown persisted result; null = unsupported → caller fails closed. */
export function parseStrategyCollectionResult(raw: unknown): StrategyCollectionResult | null {
  const parsed = StrategyCollectionResultSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Usable contributions for preparation: successful, conflict-free. */
export function usableContributions(result: StrategyCollectionResult): CollectionContribution[] {
  if (result.identityConflict) return [];
  return result.contributions.filter((c) => c.outcome === 'success');
}
