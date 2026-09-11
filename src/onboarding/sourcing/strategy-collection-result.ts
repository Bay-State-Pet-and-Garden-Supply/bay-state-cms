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
}).superRefine((v, ctx) => {
  // Ticket #122: schema-level URL invariant — a distributor_record
  // contribution must never carry a source URL (never a fake official
  // URL), and a successful official_page contribution must carry one.
  // Enforced at parse so persisted-envelope reads fail closed, not just
  // the pure builder.
  if (v.kind === 'distributor_record' && v.sourceUrl !== null) {
    ctx.addIssue({ code: 'custom', message: 'distributor_record contributions must have sourceUrl null' });
  }
  if (v.kind === 'official_page' && v.outcome === 'success' && !v.sourceUrl) {
    ctx.addIssue({ code: 'custom', message: 'successful official_page contributions require sourceUrl' });
  }
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

// ─── Ticket #122: envelope construction from frozen binding + durable outcomes ──

import { createHash } from 'node:crypto';
import type { StrategySourceRef } from '../../shared/schemas/brand-strategy';

/** One durable attempt outcome feeding envelope construction (repo-hydrated). */
export interface StrategyCollectionAttemptInput {
  attemptId: string;
  connectionId: string;
  distributorId: string;
  providerId: string;
  outcome: 'found' | 'not_stocked' | 'source_error';
  /** Bounded stable error code for source_error attempts (never raw messages). */
  errorCode?: string | null;
  /** Persisted identity JSON for found attempts (merchandising attribution). */
  identityJson?: string | null;
  /** Persisted evidence URL (must be null for distributor attempts; enforced). */
  sourceUrl?: string | null;
  /** Approved official domain for official_page attempts (null-connection rows). */
  domain?: string | null;
}

/** Merchandising fields extracted for attribution (bounded string values only). */
const ENVELOPE_FIELD_KEYS = ['name', 'description', 'brand', 'weight', 'distributorSku'] as const;

function extractEnvelopeFields(identityJson: string | null | undefined): Record<string, string> {
  const fields: Record<string, string> = {};
  if (!identityJson) return fields;
  let identity: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(identityJson);
    if (!parsed || typeof parsed !== 'object') return fields;
    identity = parsed as Record<string, unknown>;
  } catch {
    return fields;
  }
  for (const key of ENVELOPE_FIELD_KEYS) {
    const value = identity[key];
    if (typeof value === 'string' && value.trim()) fields[key] = value.slice(0, 2000);
  }
  return fields;
}

function contributionSortKey(c: CollectionContribution): string {
  return `${c.kind}|${c.providerId}|${c.connectionId ?? ''}|${[...c.attemptIds].sort().join(',')}`;
}

/**
 * Canonical SHA-256 hex over the deterministic envelope payload. The
 * contribution order is normalized (sorted) before hashing so acquisition
 * order never affects the digest — connector completion order is not
 * field precedence and must not perturb identity.
 */
export function computeStrategyCollectionHash(result: StrategyCollectionResult): string {
  const canonical = {
    version: result.version,
    itemId: result.itemId,
    sourcingGenerationId: result.sourcingGenerationId,
    strategyRevision: result.strategyRevision,
    strategyBrand: result.strategyBrand,
    identityConflict: result.identityConflict,
    contributions: [...result.contributions]
      .sort((a, b) => (contributionSortKey(a) < contributionSortKey(b) ? -1 : 1))
      .map((c) => ({
        kind: c.kind,
        connectionId: c.connectionId,
        providerId: c.providerId,
        attemptIds: [...c.attemptIds].sort(),
        sourceUrl: c.sourceUrl,
        outcome: c.outcome,
        reasonCode: c.reasonCode ?? null,
        fields: Object.fromEntries(Object.entries(c.fields).sort(([a], [b]) => (a < b ? -1 : 1))),
      })),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Build a versioned collection envelope from the frozen strategy binding
 * sources plus the generation's durable attempt outcomes. Pure.
 *
 * - Every distributor source in the frozen boundary yields at least one
 *   contribution: per-connection outcomes where connections exist, or a
 *   single `unavailable` contribution (connection_not_configured) where the
 *   selected distributor has no enabled connection. Selected sources are
 *   never silently dropped.
 * - Contributions are sorted deterministically (acquisition order independent).
 * - Fails closed (null): empty source set, any non-distributor source in the
 *   boundary (official_page/mixed is never silently filtered — the caller
 *   must gate to a distributor-only boundary first), distributor sourceUrl
 *   present, or schema parse failure.
 *
 * Returns the result plus its canonical hash and the attempt inputs echoed
 * for callers that persist provenance.
 */
export function buildStrategyCollectionEnvelope(input: {
  itemId: string;
  generationId: string;
  strategyRevision: number;
  strategyBrand: string;
  sources: StrategySourceRef[];
  attempts: StrategyCollectionAttemptInput[];
  unavailableDistributorIds: string[];
  identityConflict?: boolean;
}): { result: StrategyCollectionResult; hash: string; attemptInputs: StrategyCollectionAttemptInput[] } | null {
  if (!Number.isInteger(input.strategyRevision) || input.strategyRevision < 1) return null;
  if (!input.itemId || !input.generationId || !input.strategyBrand) return null;
  // Ticket #123: distributor-only AND mixed (official_page + distributor)
  // boundaries build envelopes. Every source must be a typed, identified
  // boundary entry — anything else fails closed (never silently filtered,
  // never an unapproved kind).
  for (const s of input.sources) {
    if (s.kind === 'distributor_record') {
      if (!s.distributorId) return null;
    } else if (s.kind === 'official_page') {
      if (!s.domain) return null;
    } else {
      return null;
    }
  }
  const distributorSources = input.sources.filter((s) => s.kind === 'distributor_record' && s.distributorId);
  const officialSourceList = input.sources.filter((s) => s.kind === 'official_page' && s.domain);
  if (distributorSources.length === 0 && officialSourceList.length === 0) return null;

  const attemptsByDistributor = new Map<string, StrategyCollectionAttemptInput[]>();
  for (const a of input.attempts) {
    const list = attemptsByDistributor.get(a.distributorId) ?? [];
    list.push(a);
    attemptsByDistributor.set(a.distributorId, list);
  }

  const contributions: CollectionContribution[] = [];
  for (const src of distributorSources) {
    const distributorId = src.distributorId as string;
    const related = [...(attemptsByDistributor.get(distributorId) ?? [])]
      .sort((a, b) => (a.attemptId < b.attemptId ? -1 : 1));
    if (related.length === 0) {
      // Selected but nothing attempted (e.g. no enabled connection at
      // collection time): explicit unavailable, never a silent drop.
      contributions.push({
        kind: 'distributor_record',
        connectionId: null,
        providerId: distributorId,
        attemptIds: [],
        sourceUrl: null,
        outcome: 'unavailable',
        reasonCode: 'connection_not_configured',
        fields: {},
      });
      continue;
    }
    for (const a of related) {
      if (a.outcome === 'found') {
        contributions.push({
          kind: 'distributor_record',
          connectionId: a.connectionId,
          providerId: a.providerId,
          attemptIds: [a.attemptId],
          sourceUrl: null,
          outcome: 'success',
          fields: extractEnvelopeFields(a.identityJson),
        });
      } else if (a.outcome === 'not_stocked') {
        contributions.push({
          kind: 'distributor_record',
          connectionId: a.connectionId,
          providerId: a.providerId,
          attemptIds: [a.attemptId],
          sourceUrl: null,
          outcome: 'no_match',
          reasonCode: 'not_stocked',
          fields: {},
        });
      } else {
        contributions.push({
          kind: 'distributor_record',
          connectionId: a.connectionId,
          providerId: a.providerId,
          attemptIds: [a.attemptId],
          sourceUrl: null,
          outcome: 'failed',
          reasonCode: (a.errorCode ?? 'source_error').slice(0, 64),
          fields: {},
        });
      }
    }
  }
  // Explicit unavailable markers for engine-reported missing connections
  // not already covered above (defense in depth; deduped by distributor).
  const covered = new Set(distributorSources.map((s) => (s.distributorId as string).toLowerCase()));
  for (const id of input.unavailableDistributorIds) {
    if (covered.has(id.toLowerCase())) continue;
    contributions.push({
      kind: 'distributor_record',
      connectionId: null,
      providerId: id,
      attemptIds: [],
      sourceUrl: null,
      outcome: 'unavailable',
      reasonCode: 'connection_not_configured',
      fields: {},
    });
  }
  // Ticket #123: one contribution set per approved official domain.
  // Profile/setup problems arrive as terminal attempts (profile_required /
  // profile_not_healthy → unavailable); verification/extraction problems
  // arrive as not_stocked / failed. A planned domain with no attempt at
  // all is an interrupted collection — fail closed (finalization owns the
  // incomplete_collection guard; the builder never invents coverage).
  const officialSources = officialSourceList;
  const attemptsByDomain = new Map<string, StrategyCollectionAttemptInput[]>();
  for (const a of input.attempts) {
    if (!a.domain) continue;
    const list = attemptsByDomain.get(a.domain.toLowerCase()) ?? [];
    list.push(a);
    attemptsByDomain.set(a.domain.toLowerCase(), list);
  }
  for (const src of officialSources) {
    const domain = (src.domain as string).toLowerCase();
    const related = [...(attemptsByDomain.get(domain) ?? [])]
      .sort((a, b) => (a.attemptId < b.attemptId ? -1 : 1));
    if (related.length === 0) return null;
    for (const a of related) {
      if (a.outcome === 'found') {
        // A verified official success without its verified URL is corrupt
        // (never a URL-less official contribution).
        if (!a.sourceUrl) return null;
        contributions.push({
          kind: 'official_page',
          connectionId: null,
          providerId: a.providerId,
          attemptIds: [a.attemptId],
          sourceUrl: a.sourceUrl,
          outcome: 'success',
          fields: extractEnvelopeFields(a.identityJson),
        });
      } else if (a.outcome === 'not_stocked') {
        contributions.push({
          kind: 'official_page',
          connectionId: null,
          providerId: a.providerId,
          attemptIds: [a.attemptId],
          sourceUrl: null,
          outcome: 'no_match',
          reasonCode: 'not_stocked',
          fields: {},
        });
      } else {
        const code = (a.errorCode ?? 'source_error').slice(0, 64);
        const unavailable = code === 'profile_required' || code === 'profile_not_healthy';
        contributions.push({
          kind: 'official_page',
          connectionId: null,
          providerId: a.providerId,
          attemptIds: [a.attemptId],
          sourceUrl: null,
          outcome: unavailable ? 'unavailable' : 'failed',
          reasonCode: code,
          fields: {},
        });
      }
    }
  }
  if (contributions.length === 0) return null;
  contributions.sort((a, b) => (contributionSortKey(a) < contributionSortKey(b) ? -1 : 1));

  const result = buildStrategyCollectionResult({
    itemId: input.itemId,
    sourcingGenerationId: input.generationId,
    strategyRevision: input.strategyRevision,
    strategyBrand: input.strategyBrand,
    contributions,
    identityConflict: input.identityConflict ?? false,
  });
  if (!result) return null;
  return { result, hash: computeStrategyCollectionHash(result), attemptInputs: input.attempts };
}
