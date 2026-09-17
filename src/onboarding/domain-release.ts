/**
 * Epic #46 Phase 2 — automation-owned progression: domain-level extraction
 * release.
 *
 * When an extractor profile for a domain becomes usable, blocked extraction
 * items on that domain (stage `extraction`, stage_status `failed`/`needs_input`)
 * must be automatically re-queued — WITHOUT the Store Manager opening each
 * SKU. This module owns that deterministic release:
 *
 * - `releaseDomainExtractionItems(workspaceId, domain, options?)` — the
 *   canonical release primitive (also exposed via the routes agent's
 *   `POST /api/onboarding/domains/:domain/release` endpoint).
 * - `sweepDomainReleases(workspaceId)` — the worker poll-loop sweep: every
 *   blocked extraction item whose domain NOW has a usable profile is released
 *   automatically.
 * - `getDomainReleaseHealth(domain)` — the reviewed-health gate (issue
 *   #198): every automatic release path consults this before moving items.
 *   Contrast (issue #215): automatic release here is health-gated; selected
 *   retry (`POST /api/onboarding/settings/profile-retry-preview/:domain/retry`)
 *   is a separate deliberate workspace-scoped failed-extraction-only operator
 *   act intentionally available WITHOUT reviewed health (gate: failed
 *   extraction + own workspace).
 *
 * Safety properties (fail closed):
 * - distributor-record sources are never released (no page; deterministic
 *   materialization — a profile has nothing to do with them);
 * - RELEASE REQUIRES REVIEWED HEALTH (issue #198): a usable profile means
 *   the domain satisfies the authoritative activation rule — an active
 *   profile version, a passing matrix containing at least the title with
 *   matching artifact hashes, 3 confirmed samples or an audited waiver,
 *   and the image bar satisfied. Creating, saving, or activating a profile
 *   for a not-yet-healthy domain releases nothing; legacy `extractor_profiles`
 *   rows alone are never sufficient;
 * - by default only PROFILE-BLOCKED failures are released (error text
 *   `No extractor profile for …`); generic scrape failures stay manual so the
 *   sweep can never hot-loop a product-data failure (`releaseAllBlocked`
 *   releases every blocked item on the domain — the explicit operator-triggered
 *   path after profile setup);
 * - RELEASES NEED NO RECENCY GUARD: extraction's own 2-retry cap
 *   (`incrementRetryCount` in the worker) already prevents release→fail→release
 *   loops, and a profile is either usable now or it is not. An item whose
 *   retries are exhausted (`retry_count >= 2`) is never auto-released — the
 *   operator must make a deliberate per-item reset.
 * - releases are idempotent (guarded UPDATE re-asserts blocked status).
 * - VARIANT-IDENTITY HOLD (issue #218): items whose evidence cannot
 *   enforce variant identity (variant-gate `variant:…` errors, a
 *   non-selected/non-resolved `onboarding_variant_resolutions` row, or an
 *   explicit unresolved variant-identity disposition for no-matrix
 *   variant-bearing pages) are
 *   excluded from BOTH the automatic sweep and bulk (`releaseAllBlocked`)
 *   activation-triggered release, with a `variant_resolution_required`
 *   skip reason. They wait for operator variant selection by
 *   construction — one approval never sweeps them in.
 */
import {
  listBlockedExtractionItemsByWorkspace,
  requeueBlockedExtractionItem,
} from '../db/repositories/onboarding-item-repo';
import { findProfileByDomain } from '../db/repositories/extractor-profile-repo';
import { evaluateActiveVersionHealth } from './domain-version-health';
import { variantIdentityEligibilityForItem, type VariantIdentityEligibility, type VariantIdentityEligibilityInput, type VariantIdentityResolutionView } from './variant-identity-eligibility';
import { getVariantIdentityDisposition } from '../db/repositories/variant-identity-disposition-repo';
import { createVariantResolutionRepo } from '../db/repositories/onboarding-variant-resolution-repo';
import { getDb } from '../db/connection';
import { onboardingEvents } from './sse-emitter';

/** Error signature written by `processExtraction` when a profile is missing. */
export const PROFILE_BLOCKED_ERROR_PATTERN = /No extractor profile for/i;

/** Normalize a domain for comparison (lowercase, trim, strip leading `www.`). */
export function normalizeReleaseDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '').trim();
}

/** Normalized hostname of a URL (lowercase, `www.` stripped); '' when unparsable. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export interface DomainReleaseResult {
  domain: string;
  profileAvailable: boolean;
  releasedIds: string[];
  skipped: Array<{ itemId: string; reason: string }>;
  /** Reviewed-health reason when the release was refused (issue #198); null when released or when no profile exists at all. */
  healthReason?: string | null;
}

/** Reviewed-health verdict for a domain (issue #198). */
export interface DomainReleaseHealth {
  healthy: boolean;
  /** Machine-readable reason (`no_usable_profile`, `no_active_version`, gate block reasons, …); null when healthy. */
  reason: string | null;
}

/**
 * Reviewed-health gate for the release path (issue #198).
 *
 * A domain is releasable only when it satisfies the SAME authoritative
 * activation rule the activation route enforces: an active profile version
 * whose test-matrix evidence passes (contains at least the title, artifact
 * hashes match), 3 confirmed representative samples or an audited waiver,
 * and the image bar satisfied. Legacy `extractor_profiles` rows alone —
 * however they were written (builder save, domain-config save, promoter
 * approval, rollback) — never constitute health.
 *
 * Issue #214: the gate inputs are assembled exactly once, in the shared
 * `evaluateActiveVersionHealth` evaluator (same definition the activation
 * route evaluates candidates against). This function keeps only the
 * release-specific footprint nuance (`no_usable_profile` when the domain
 * has no profile footprint at all).
 *
 * Fail-closed: any evaluation error yields unhealthy.
 */
export function getDomainReleaseHealth(domain: string): DomainReleaseHealth {
  const normalized = normalizeReleaseDomain(domain);
  try {
    const verdict = evaluateActiveVersionHealth(normalized);
    if (!verdict.healthy && verdict.reason === 'no_active_version') {
      // Preserve the long-standing reason when the domain has no profile
      // footprint at all; otherwise report the precise health gap.
      const legacyProfile = findProfileByDomain(normalized);
      if (!legacyProfile) return { healthy: false, reason: 'no_usable_profile' };
    }
    return { healthy: verdict.healthy, reason: verdict.reason };
  } catch (_e) {
    return { healthy: false, reason: 'health_check_failed' };
  }
}

export interface DomainReleaseOptions {
  /**
   * When true, every blocked (failed/needs_input) extraction item on the
   * domain is released once a usable profile exists, regardless of the
   * failure text. Intended for the explicit operator-triggered endpoint
   * (profile just set up → release everything on that domain). The worker
   * sweep always uses the default (profile-blocked errors only).
   */
  releaseAllBlocked?: boolean;
}

/**
 * Canonical domain release. Re-queues eligible blocked extraction items on
 * the domain (guards above). Emits an SSE `item:status` (pending, stage
 * extraction, autoReleased) per released item.
 */
export function releaseDomainExtractionItems(
  workspaceId: string,
  domain: string,
  options: DomainReleaseOptions = {},
): DomainReleaseResult {
  const normalized = normalizeReleaseDomain(domain);
  // Issue #198: the ONLY usability signal is reviewed health. Legacy
  // `extractor_profiles` rows alone never release — otherwise every
  // builder/config/promoter save would silently requeue items before the
  // activation gate is satisfied.
  const health = getDomainReleaseHealth(normalized);
  if (!health.healthy) {
    return {
      domain: normalized,
      profileAvailable: false,
      releasedIds: [],
      skipped: [{ itemId: '', reason: health.reason ?? 'not_healthy' }],
      healthReason: health.reason,
    };
  }

  // Domain-scoped blocked pool. Foreign-host, URL-less, and retry-exhausted
  // rows drop silently here (pre-existing semantics); everything else flows
  // through the variant hold below so no path drops variant-bearing rows
  // without a reason.
  const candidates = listBlockedExtractionItemsByWorkspace(workspaceId).filter(row => {
    if (!row.source_url) return false;
    if (hostOf(row.source_url) !== normalized) return false;
    // Epic #46 audit fix (fix 4): no recency guard — a usable profile NOW is
    // the only condition. Extraction's own 2-retry cap prevents hot loops.
    if (row.retry_count >= 2) return false;
    return true;
  });

  const releasedIds: string[] = [];
  const skipped: Array<{ itemId: string; reason: string }> = [];
  // Issue #218 — variant-identity rollout hold (runtime predicate, not a
  // prose caveat): template pages whose evidence cannot enforce variant
  // identity never release automatically or via bulk activation. The hold
  // runs BEFORE the profile-blocked pre-filter so BOTH paths record
  // variant-unidentifiable rows in `skipped` with a clear reason — one
  // approval cannot sweep them in, and the sweep never drops them
  // silently. Variant-unidentifiable items wait for operator variant
  // selection by construction.
  const variantRepo = createVariantResolutionRepo(getDb());
  const holdSurvivors = candidates.filter(row => {
    try {
      const current = variantRepo.getCurrentForItem(row.id);
      const resolutionView: VariantIdentityResolutionView | null = current
        ? { status: current.status, selected_variant_key: current.selected_variant_key, automatic_variant_key: current.automatic_variant_key }
        : null;
      // Explicit unresolved variant-identity disposition (no-matrix
      // Sitecore case): read inside the same fail-closed try so a read
      // failure holds rather than releases blind.
      const variantDisposition = getVariantIdentityDisposition(row.id);
      const holdInput: VariantIdentityEligibilityInput = { itemId: row.id, errorMessage: row.error_message, variantResolution: resolutionView, variantDisposition };
      const variantHold: VariantIdentityEligibility = variantIdentityEligibilityForItem(holdInput);
      if (!variantHold.eligible) {
        skipped.push({ itemId: row.id, reason: variantHold.reason });
        return false;
      }
      return true;
    } catch (_e) {
      skipped.push({ itemId: row.id, reason: 'variant_resolution_required: variant identity check failed — operator variant selection required first' });
      return false;
    }
  });
  // Default sweep releases only profile-blocked failures so generic scrape
  // failures never hot-loop; the explicit bulk path releases every hold
  // survivor on the domain.
  const eligible = options.releaseAllBlocked
    ? holdSurvivors
    : holdSurvivors.filter(row => PROFILE_BLOCKED_ERROR_PATTERN.test(row.error_message ?? ''));
  for (const row of eligible) {
    if (requeueBlockedExtractionItem(row.id)) {
      releasedIds.push(row.id);
      onboardingEvents.emitItemStatus(row.batch_id, row.id, 'pending', {
        stage: 'collect_details',
        autoReleased: true,
        reason: 'extractor profile now usable',
        domain: normalized,
      });
    } else {
      skipped.push({ itemId: row.id, reason: 'transition_failed' });
    }
  }
  return { domain: normalized, profileAvailable: true, releasedIds, skipped };
}

export interface DomainReleaseSweepResult {
  releasedIds: string[];
  domains: string[];
}

/**
 * Worker poll-loop sweep: find every domain with blocked extraction items
 * that NOW satisfies reviewed health and release those items. One scoped
 * query + per-domain health evaluations; no-op (and cheap) when nothing is
 * blocked. Uses the default profile-blocked-only filter so generic scrape
 * failures never hot-loop.
 */
export function sweepDomainReleases(workspaceId: string): DomainReleaseSweepResult {
  const blocked = listBlockedExtractionItemsByWorkspace(workspaceId);
  const domains = new Set<string>();
  for (const row of blocked) {
    if (!row.source_url) continue;
    const host = hostOf(row.source_url);
    if (host) domains.add(host);
  }
  const releasedIds: string[] = [];
  const releasedDomains: string[] = [];
  for (const domain of domains) {
    const res = releaseDomainExtractionItems(workspaceId, domain);
    if (res.releasedIds.length > 0) {
      releasedIds.push(...res.releasedIds);
      releasedDomains.push(domain);
    }
  }
  return { releasedIds, domains: releasedDomains };
}
