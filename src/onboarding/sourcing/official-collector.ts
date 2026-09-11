import { discoverSources } from '../source-discovery';
import { verifyTopCandidates } from '../page-verifier';
import { findProfileByDomain } from '../../db/repositories/extractor-profile-repo';
import { getDomainProfileState } from '../../db/repositories/domain-profile-state-repo';
import { runProfileExtraction, type ProfileRunnerResult } from '../profile-runner-client';
import { isKnownRetailerOrDistributorDomain } from '../discovery/retailer-domain-list';
import { isOfficialDomainMatch } from '../domain-utils';
import {
  insertEvidenceAttempt,
  getEvidenceAttemptsByItemAndGeneration,
} from '../../db/repositories/onboarding-evidence-repo';
import type { SourcingGenerationAttemptSummary } from './contracts';
import type { EvidenceLookupOutcome } from '../../shared/schemas/distributor-evidence';

/**
 * Ticket #123: engine-synchronous official-page collection inside the
 * frozen approved strategy boundary.
 *
 * One approved official domain → exactly one terminal durable evidence
 * attempt per generation (found / not_stocked / source_error), persisted
 * through the single evidence writer BEFORE finalization. Never an
 * unapproved fallback: discovery is scoped to the frozen domain, candidates
 * outside it are filtered before any network call, and extraction is
 * strictly profile-only (a missing/unhealthy profile is a terminal
 * `profile_required` / `profile_not_healthy` outcome — never a generic
 * HTTP fallback, never a fake URL).
 *
 * Provider identity for official attempts is `official_page:<domain>` with
 * a NULL distributor connection. Deduplication is explicit (provider lookup
 * within the generation) because the evidence table's unique index only
 * covers non-null connections — null connection alone is not official
 * idempotency.
 */

export function officialProviderId(domain: string): string {
  return `official_page:${domain.trim().toLowerCase()}`;
}

/** Skip-entry connection id for official sources (mirrors the engine's distributor skip shape). */
export function officialSkipId(domain: string): string {
  return `strategy:official:${domain.trim().toLowerCase() || 'website'}`;
}

export interface OfficialCollectorDeps {
  discover?: typeof discoverSources;
  verify?: typeof verifyTopCandidates;
  extract?: (args: {
    url: string;
    profile: NonNullable<ReturnType<typeof findProfileByDomain>>;
    expected: { name: string; brandHint: string | null; upc: string };
    allowedDomains: string[];
  }) => Promise<ProfileRunnerResult>;
  findProfile?: typeof findProfileByDomain;
  /** Healthy applicable profile gate (default: hasProfile + tests-pass evidence). */
  isProfileHealthy?: (domain: string) => boolean;
  fetchFn?: typeof fetch;
}

export type OfficialCollectionOutcome =
  | { kind: 'attempt'; summary: SourcingGenerationAttemptSummary }
  | { kind: 'skipped'; connectionId: string; reason: string };

/** Minimum remaining generation budget (ms) to start another network phase. */
const MIN_PHASE_BUDGET_MS = 8_000;

function remainingMs(deadlineAt: string): number {
  const remaining = new Date(deadlineAt).getTime() - Date.now();
  return Number.isFinite(remaining) ? remaining : 0;
}

function defaultProfileHealthy(domain: string): boolean {
  try {
    const state = getDomainProfileState(domain);
    return state.hasProfile && state.testsPassEvidence != null;
  } catch {
    return false;
  }
}

async function defaultExtract(args: {
  url: string;
  profile: NonNullable<ReturnType<typeof findProfileByDomain>>;
  expected: { name: string; brandHint: string | null; upc: string };
  allowedDomains: string[];
}): Promise<ProfileRunnerResult> {
  // Strict profile-only extraction: the worker runs the domain's approved
  // CSS selectors deterministically (never generic extraction, never an
  // LLM). The profile's own domain is always allowlisted; the approved
  // domain is passed explicitly so redirects/sub-resources stay inside the
  // frozen boundary.
  return runProfileExtraction({
    sourceUrl: args.url,
    profile: args.profile,
    expected: { name: args.expected.name, brandHint: args.expected.brandHint, upc: args.expected.upc },
    allowedSourceDomains: args.allowedDomains,
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export async function collectOfficialDomain(input: {
  itemId: string;
  generationId: string;
  workspaceId: string;
  domain: string;
  identifier: string;
  itemName: string | null;
  brandHint: string | null;
  signal: AbortSignal;
  deadlineAt: string;
  deps?: OfficialCollectorDeps;
}): Promise<OfficialCollectionOutcome> {
  const deps = input.deps ?? {};
  const discover = deps.discover ?? discoverSources;
  const verify = deps.verify ?? verifyTopCandidates;
  const extract = deps.extract ?? defaultExtract;
  const findProfile = deps.findProfile ?? findProfileByDomain;
  const isHealthy = deps.isProfileHealthy ?? defaultProfileHealthy;
  const fetchFn = deps.fetchFn ?? fetch;
  const domain = input.domain.trim().toLowerCase();
  const providerId = officialProviderId(domain);
  const skipId = officialSkipId(domain);
  const startedAt = Date.now();

  const persistTerminal = (
    outcome: EvidenceLookupOutcome,
    fields: {
      evidenceUrl?: string | null;
      identity?: Record<string, unknown> | null;
      matchedFields?: string[];
      errorCode?: string | null;
      errorMessage?: string | null;
    } = {},
  ): OfficialCollectionOutcome => {
    const attempt = insertEvidenceAttempt({
      itemId: input.itemId,
      providerId,
      distributorConnectionId: null,
      lookupUpc: input.identifier,
      outcome,
      confidence: outcome === 'found' ? 0.9 : 0,
      evidenceUrl: fields.evidenceUrl ?? null,
      matchedFields: fields.matchedFields ?? [],
      identityJson: fields.identity ? JSON.stringify(fields.identity) : null,
      warningsJson: null,
      errorCode: fields.errorCode ?? null,
      errorMessage: fields.errorMessage ?? null,
      // Observation provenance floor (same rule as the distributor engine):
      // engine-observed attempts always carry observedAt + catalogVersion
      // so the floor never blocks on provider metadata.
      catalogVersion: new Date().toISOString().slice(0, 10),
      sourcingGenerationId: input.generationId,
      observedAt: new Date().toISOString(),
      expiresAt: null,
      durationMs: Date.now() - startedAt,
    });
    return {
      kind: 'attempt',
      summary: {
        attemptId: attempt.id,
        connectionId: '',
        providerId,
        outcome,
        matchedIdentifier: outcome === 'found' ? input.identifier : null,
        errorCode: fields.errorCode ?? null,
      },
    };
  };

  // Resume-safety / idempotency: a terminal attempt for this generation +
  // domain already exists — never collect twice, never rewrite.
  const existing = getEvidenceAttemptsByItemAndGeneration(input.itemId, input.generationId)
    .find((a) => a.distributorConnectionId == null && a.providerId.toLowerCase() === providerId);
  if (existing) {
    return {
      kind: 'attempt',
      summary: {
        attemptId: existing.id,
        connectionId: '',
        providerId,
        outcome: existing.outcome,
        matchedIdentifier: existing.outcome === 'found' ? input.identifier : null,
        errorCode: existing.errorCode ?? null,
      },
    };
  }
  if (input.signal.aborted) {
    return { kind: 'skipped', connectionId: skipId, reason: 'deadline_exceeded' };
  }

  // Authority defense in depth (approval already rejects these): a known
  // retailer/distributor host is never an official source. Fail closed
  // without any network call.
  if (isKnownRetailerOrDistributorDomain(domain)) {
    return persistTerminal('source_error', {
      errorCode: 'retailer_domain',
      errorMessage: `'${domain}' is a known retailer/distributor host, not an official brand domain`,
    });
  }

  // Strict profile gate: no profile (or no healthy applicable profile)
  // means a terminal unavailable outcome — never a generic HTTP fallback.
  let profile: NonNullable<ReturnType<typeof findProfileByDomain>>;
  try {
    const found = findProfile(domain);
    if (!found) {
      return persistTerminal('source_error', {
        errorCode: 'profile_required',
        errorMessage: `No extractor profile for ${domain} — profile required`,
      });
    }
    profile = found;
  } catch {
    return persistTerminal('source_error', {
      errorCode: 'profile_required',
      errorMessage: `No extractor profile for ${domain} — profile required`,
    });
  }
  let healthy = false;
  try {
    healthy = isHealthy(domain);
  } catch {
    healthy = false;
  }
  if (!healthy) {
    return persistTerminal('source_error', {
      errorCode: 'profile_not_healthy',
      errorMessage: `Extractor profile for ${domain} is not healthy — profile setup required`,
    });
  }

  if (remainingMs(input.deadlineAt) < MIN_PHASE_BUDGET_MS) {
    return { kind: 'skipped', connectionId: skipId, reason: 'deadline_exceeded' };
  }

  // Frozen-domain discovery: exactly this domain, never live mappings.
  // Authority match (exact-or-subdomain) is the SAME predicate manual
  // select-source uses, so an admitted candidate always survives
  // collection filtering and vice versa — one domain policy, no drift.
  let candidates: Awaited<ReturnType<typeof discoverSources>>['candidates'];
  try {
    const discovered = await discover(input.identifier, input.itemName ?? '', input.brandHint, {
      networkFetch: fetchFn as never,
      frozenDomains: [domain],
    });
    candidates = discovered.candidates.filter((c) => isOfficialDomainMatch(hostOf(c.url), domain));
  } catch (err) {
    return persistTerminal('source_error', {
      errorCode: 'discover_failed',
      errorMessage: err instanceof Error ? err.message.slice(0, 200) : 'official discovery failed',
    });
  }
  if (candidates.length === 0) {
    return persistTerminal('not_stocked');
  }

  // Verification with bounded diagnostics: count transport rejections so a
  // wall of blocked fetches never masquerades as a genuine no-match.
  let fetchFailures = 0;
  const countingFetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    try {
      return await fetchFn(url, init);
    } catch (err) {
      fetchFailures += 1;
      throw err;
    }
  }) as typeof fetch;
  let verified: Awaited<ReturnType<typeof verifyTopCandidates>>[number] | null = null;
  try {
    const results = await verify(
      candidates,
      { upc: input.identifier, expectedName: input.itemName ?? '', brandHint: input.brandHint, officialDomains: [domain] },
      3,
      countingFetch,
      { signal: input.signal, timeoutMs: Math.max(1_000, remainingMs(input.deadlineAt) - 2_000) },
    );
    verified = results.find((r) => r.hasStrongProof) ?? null;
  } catch {
    return persistTerminal('source_error', {
      errorCode: 'verify_failed',
      errorMessage: 'official verification failed',
    });
  }
  if (!verified) {
    return persistTerminal(fetchFailures > 0 ? 'source_error' : 'not_stocked', fetchFailures > 0
      ? { errorCode: 'fetch_failed', errorMessage: `${fetchFailures} candidate fetch(es) failed during verification` }
      : {});
  }

  if (remainingMs(input.deadlineAt) < MIN_PHASE_BUDGET_MS || input.signal.aborted) {
    return { kind: 'skipped', connectionId: skipId, reason: 'deadline_exceeded' };
  }

  // Strict profile-only extraction inside the frozen domain boundary.
  let extracted: ProfileRunnerResult;
  try {
    extracted = await extract({
      url: verified.candidate.url,
      profile,
      expected: { name: input.itemName ?? '', brandHint: input.brandHint, upc: input.identifier },
      allowedDomains: [domain],
    });
  } catch (err) {
    return persistTerminal('source_error', {
      errorCode: 'extract_failed',
      errorMessage: err instanceof Error ? err.message.slice(0, 200) : 'official extraction failed',
    });
  }
  // Never persist a late write after cancellation/deadline.
  if (input.signal.aborted) {
    return { kind: 'skipped', connectionId: skipId, reason: 'deadline_exceeded' };
  }
  if (!extracted.ok || !extracted.data.title) {
    const code = !extracted.ok && extracted.failureCode ? String(extracted.failureCode).slice(0, 64) : 'extract_failed';
    return persistTerminal('source_error', {
      errorCode: code,
      errorMessage: !extracted.ok ? extracted.error.slice(0, 200) : 'official extraction returned no title',
    });
  }
  const data = extracted.data;
  return persistTerminal('found', {
    evidenceUrl: verified.candidate.url,
    matchedFields: ['upc'],
    identity: {
      upc: input.identifier,
      name: data.title ?? undefined,
      brand: data.brand ?? input.brandHint ?? undefined,
      description: data.description ?? undefined,
      weight: data.weight ?? undefined,
    },
  });
}
