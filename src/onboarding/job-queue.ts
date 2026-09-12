import {
  claimItemsForProcessing,
  requeueStaleInProgressItems,
  updateItemStageStatus,
  incrementRetryCount,
  setDiscoverySourceUrl,
  listItemsByBatch,
  releaseHeldFamilyClaim,
} from '../db/repositories/onboarding-item-repo';
import { randomUUID } from 'node:crypto';
import { discoverSources } from './source-discovery';
import { captureModelPolicySnapshot } from './model-policy-snapshot';
import {
  insertSources,
  deleteSourcesByItem,
  selectSource,
  createDiscoveryRun,
  updateDiscoveryRunStep,
  completeDiscoveryRun,
  failDiscoveryRun,
  stampSourcesWithDiscoveryRun,
  type InsertSourceData,
} from '../db/repositories/onboarding-source-repo';
import { verifyTopCandidates, type VerificationResult } from './page-verifier';
import { findBrandSites } from '../db/repositories/brand-site-repo';
import { extractProductData, VariantExtractionError } from './page-extractor';
import { createVariantResolutionRepo } from '../db/repositories/onboarding-variant-resolution-repo';
import { getEffectiveVariantResolutionMode } from './variant-flags';
import { assertSafeVariantDestination } from '../shared/ssrf';

/** P0: policy-gateway variant discovery fetch — single-hop, shared destination assertion, manual redirect. General sitemap discovery remains redirect-aware (see sitemap-fetcher), variant resolution owns redirect loop per-hop with 500ms accounting. */
export function createVariantDiscoveryFetch(officialDomains: string[]): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    await assertSafeVariantDestination(urlStr, officialDomains);
    return fetch(urlStr, { ...(init || {}), redirect: 'manual' as RequestRedirect });
  };
}
export function createDiscoveryFetch(officialDomains: string[]): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    let current = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    for (let hop = 0; hop <= 3; hop++) {
      await assertSafeVariantDestination(current, officialDomains);
      const res = await fetch(current, { ...(init || {}), redirect: 'manual' as RequestRedirect });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        current = new URL(loc, current).toString();
        continue;
      }
      return res;
    }
    throw new Error('discovery fetch redirect limit');
  };
}
import { enrichUrlMetadata } from '../db/repositories/brand-url-index-repo';
import { findProfileByDomain } from '../db/repositories/extractor-profile-repo';
import { curateItemWithPipeline } from './product-curator';
import { refreshCandidateCohorts } from './curation-cohort-service';
import {
  createCohortCuration,
  observeCohortShadowTypeResolution,
} from './cohort-curation/index';
import type { CohortCuration } from './cohort-curation/index';
import type { CohortShadowObservation } from './cohort-curation/index';


import { getCohortCurationFlags } from '../classification/flags';
import type { CohortCurationFlags } from '../classification/flags';
import {
  claimReadyCurationCohorts,
  reclaimExpiredCohortRuns,
  getCurrentCohortRun,
  supersedeCohortRun,
  COHORT_LEASE_TTL_MS,
} from '../db/repositories/classification-cohort-run-repo';
import { getCohortById, getCohortMembers, listCohortsByWorkspace, listWaitingCohortMemberIdsByWorkspace, insertCohortShadowObservationIfChanged } from '../db/repositories/curation-cohort-repo';
import { findBatchById } from '../db/repositories/onboarding-batch-repo';
import type { CohortRun } from '../shared/schemas/cohorts';
import { determineProductGroup } from './product-line-grouper';
import { validateSiblingConsistency, activeCohortSemanticFindingsForItem } from '../classification/consistency-validator';
import { insertExtraction } from '../db/repositories/onboarding-extraction-repo';
import { onboardingEvents } from './sse-emitter';
import { getDb } from '../db/connection';
import { readStoreConfig } from '../git/workspace-files';
import type { OnboardingItem, OnboardingSource, PipelineStage } from '../shared/schemas/onboarding';
import { getSourcingFlags } from './flags';
import { normalizeGtin } from './sourcing/contracts';
import { listCurrentGenerationConflictsForItem } from '../db/repositories/onboarding-conflict-repo';
import type { SourcingConflict } from '../shared/schemas/onboarding';
import type { SourcingEngine } from './sourcing/contracts';
import { DefaultSourcingEngine } from './sourcing/engine';
import { reconcileDistributorEvidence } from './sourcing-reconciler';
import { buildDistributorRecordProjection } from './sourcing/distributor-record-projection';
import {
  materializeDistributorRecordExtraction,
  materializeStrategyCollectionExtraction,
  DISTRIBUTOR_MATERIALIZATION_ERROR_CODES,
  type DistributorMaterializationResult,
} from './sourcing/distributor-record-materializer';
import { observeSourcingCandidates } from './sourcing/observation';
import { isAutomaticMode, isManualMode, isObserveMode, isCurrentSourcingEntryPolicy } from './sourcing/entry-policy';
import {
  startSourcingGeneration,
  getCurrentSourcingGeneration,
  getCurrentGenerationAttempts,
  completeSourcingGeneration,
} from '../db/repositories/onboarding-evidence-repo';
import { recordAcceptances } from '../db/repositories/onboarding-acceptance-repo';
import { completeSourcingWithDecision } from '../db/repositories/onboarding-item-repo';
import { listConnectionsByWorkspace } from '../db/repositories/distributor-repo';
import { getApprovedBrandStrategy } from '../db/repositories/brand-strategy-approval-repo';
import { getGenerationStrategyBinding, isRetiredStrategyBinding } from '../db/repositories/brand-strategy-generation-repo';
import {
  finalizeStrategyCollectionForGeneration,
  getStrategyCollectionResult,
} from '../db/repositories/strategy-collection-result-repo';
import {
  assessListingEvidenceGap,
  openPreparationGap,
  getPreparationGap,
  markCorrectionRun,
  resolveAfterValidation,
  hasUnresolvedPreparationGap,
  blockingPreparationFields,
} from '../db/repositories/preparation-gap-repo';
import type { StrategyCollectionResult } from './sourcing/strategy-collection-result';
import { usableContributions } from './sourcing/strategy-collection-result';
import type { SourcingDecision, SourcingDecisionV2 } from '../shared/schemas/onboarding';
import { sweepAutoAdvance } from './auto-advance';
import { sweepDomainReleases } from './domain-release';

/**
 * Automatic per-item processing stages (ADR 0014 Amendment A). Sourcing
 * joins the list ONLY for valid manual/automatic rollout modes with the
 * capability effective-enabled; observe mode never claims Sourcing (imports
 * enter Discovery and are shadow-observed from there), and OFF/invalid modes
 * never include it. Curation's cohort-exclusivity logic inside poll() is
 * unaffected by the stage list.
 */
function buildAutoStages(): PipelineStage[] {
  const flags = getSourcingFlags();
  const includeSourcing =
    flags.effectiveEnabled && (flags.mode === 'manual' || flags.mode === 'automatic');
  return includeSourcing
    ? ['route_sources', 'prepare_listing', 'collect_details', 'find_product_page']
    : ['prepare_listing', 'collect_details', 'find_product_page'];
}

// ─── Cohort-centric Curation V2 — see src/classification/flags.ts for rollout semantics ─────────────────

/** Cohort curation active when flag ON and not shadow-only. See src/classification/flags.ts. */
function isCohortCurationActive(flags: CohortCurationFlags): boolean {
  return flags.cohortCurationV2Enabled && !flags.cohortShadowOnly;
}

/** Terminal parent-run states that remain the current historical decision
 *  until drift supersedes them (D9 — never re-claimed while they match). */
const COHORT_RUN_TERMINAL = new Set([
  'completed',
  'completed_with_abstentions',
  'completed_with_member_failures',
  'failed',
  'cancelled',
]);

// ─── Auto-selection policy helpers ──────────────────────────────────────────────

/**
 * Normalize a domain for comparison: lowercase, trim, strip leading `www.`.
 * Returns an empty string for null/undefined/whitespace input.
 */
import { normalizeDiscoveryDomain, isOfficialDomainMatch } from './domain-utils';
export { normalizeDiscoveryDomain, isOfficialDomainMatch };

/**
 * Return the list of normalized official domains mapped to a brand.
 * Returns an empty array for blank brand hints or when the brand has
 * no entries in `brand_sites`.
 */
export function getOfficialDomainsForBrand(brandHint: string | null | undefined): string[] {
  if (!brandHint || !brandHint.trim()) return [];
  const sites = findBrandSites(brandHint);
  const domains: string[] = [];
  for (const site of sites) {
    const normalized = normalizeDiscoveryDomain(site.domain);
    if (normalized) domains.push(normalized);
  }
  return domains;
}

/** ADR 0017 commitment 2 — authority-gate predicate. An official-page candidate
 * may be auto-accepted ONLY when the item has a resolved brand hint, that brand
 * maps to at least one official domain, and the candidate's domain matches a
 * mapped domain (strict exact-or-subdomain via `isOfficialDomainMatch`).
 * Unknown or unmapped brands never auto-accept official candidates — review
 * decides authority. Identity evidence from the page verifier remains a
 * separate, additional conjunct.
 */
export function passesAuthorityGate(
  brandHint: string | null | undefined,
  officialDomains: string[],
  candidateDomain: string | null | undefined,
): boolean {
  if (!brandHint || !brandHint.trim()) return false;
  if (officialDomains.length === 0) return false;
  if (!candidateDomain) return false;
  return officialDomains.some(d => isOfficialDomainMatch(candidateDomain, d));
}

/**
 * Ticket #124 P2-11: store-configured validation severities for gap
 * derivation. Same seam as change-set validation (health-config.json
 * rules); unknown codes/severities are ignored, unreadable config yields
 * undefined (framework defaults apply).
 */
function loadPreparationRulesConfig(
  workspacePath: string,
): Record<string, 'blocker' | 'warning' | 'info' | 'disabled'> | undefined {
  try {
    const config = readStoreConfig<{ rules: Array<{ code: unknown; severity: unknown }> }>(
      workspacePath,
      'health-config.json',
    );
    if (!config || !Array.isArray(config.rules)) return undefined;
    const out: Record<string, 'blocker' | 'warning' | 'info' | 'disabled'> = {};
    for (const rule of config.rules) {
      if (typeof rule?.code !== 'string' || !rule.code) continue;
      if (rule.severity === 'blocker' || rule.severity === 'warning' || rule.severity === 'info' || rule.severity === 'disabled') {
        out[rule.code] = rule.severity;
      }
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Stage-based worker. Polls for items with stage_status = 'pending' across
 * all active batches. Processes items within their current stage; happy-path
 * progression between stages is automation-owned (sweepAutoAdvance +
 * sweepDomainReleases every poll for items satisfying their stage exit
 * contract). Manual advancement is reserved for explicit human decisions —
 * approval, export, source-conflict resolution, URL/profile exception
 * resolution. Retries are idempotent (pending requeue, never backwards).
 */
export class OnboardingWorker {
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = new Map<string, Promise<void>>();
  // Global concurrency limit across all stages.
  // Extraction has a separate, lower limit to avoid triggering bot
  // detection on target websites during concurrent page scrapes.
  private maxConcurrency = 3;
  private maxExtractionConcurrency = 3;
  private extractionRunning = 0;
  private isProcessing = false;
  /** Reviewer P1: set by stop(), cleared by start() — in-flight polls no-op. */
  private stopped = false;
  /**
   * Epic #46 refinement: the family-barrier hold emits SSE + logs ONLY when
   * the held set CHANGES. The poll loop runs every 2s — emitting per held
   * member on every poll produced constant console spam and a UI refresh
   * loop while a family waited. Members that remain held are silent.
   */
  private lastHeldFamilyBarrierIds = new Set<string>();
  private workspacePath: string;
  private workspaceId: string;
  private workerId: string;
  /** Cohort Curation execution seam (plan Slice 2): bound once, owns
   *  freeze-or-resume ordering for claimed runs. The worker keeps
   *  startup/poll reclaim, claim concurrency, dispatch, and advancement. */
  private cohortCuration: CohortCuration;
  // PR4 C5: cohortId → last logged shadow observation line. The shadow
  // observer recomputes on every poll (ready cohorts are cheap and few); the
  // log line is emitted only when the outcome detail CHANGES so shadow mode
  // never floods the worker log.
  private shadowObservedOutcomes = new Map<string, string>();
  /** Test seam: inject the sourcing engine factory (defaults to the real engine). */
  private engineFactory: (() => SourcingEngine) | null;
  /** Discovery/verification overrides (test/embedding seam, default null → real impls). */
  private deps: {
    discoverSources?: typeof discoverSources;
    verifyTopCandidates?: typeof verifyTopCandidates;
  } | null;

  /**
   * @param maxConcurrency Items processed in parallel per poll. Default 3:
   *   sourcing fans each item out across all enabled distributor connections,
   *   so 10 items meant up to 10 concurrent logins/browser sessions; 3 keeps
   *   concurrent logins bounded while still saturating the per-connection
   *   rate limits (each item walks its connections sequentially).
   */
  constructor(
    workspaceId: string,
    workspacePath: string,
    maxConcurrency = 3,
    maxExtractionConcurrency = 3,
    engineFactory?: () => SourcingEngine,
    deps?: {
      /** Test/embedding seam: discovery provider override (default: real). */
      discoverSources?: typeof discoverSources;
      /** Test/embedding seam: candidate verification override (default: real). */
      verifyTopCandidates?: typeof verifyTopCandidates;
    },
  ) {
    this.workspaceId = workspaceId;
    this.workspacePath = workspacePath;
    this.maxConcurrency = maxConcurrency;
    this.maxExtractionConcurrency = maxExtractionConcurrency;
    this.workerId = randomUUID();
    this.cohortCuration = createCohortCuration({ workspacePath, workspaceId });
    this.engineFactory = engineFactory ?? null;
    this.deps = deps ?? null;
  }

  start(): void {
    if (this.interval) return;
    this.stopped = false;

    // Requeue only items whose claim has gone stale (older than 5 minutes).
    // A live worker's in_progress items are left alone.
    try {
      const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      requeueStaleInProgressItems(this.workspaceId, staleBefore);
    } catch (err) {
      console.error('[OnboardingWorker] Failed to requeue stale in_progress items:', err);
    }

    // PR3 M3 (issue #30): startup recovery for crashed cohort workers — reclaim
    // expired cohort-run leases (resume-on-match / supersede-on-drift) right
    // next to the item stale sweep. Flag-gated: OFF/shadow mode never touches
    // cohort runs. Resumed runs are dispatched to the freeze/execute path so a
    // crash never strands a claimed cohort.
    const flags = getCohortCurationFlags();
    if (isCohortCurationActive(flags)) {
      try {
        // PR3 hardening (Commit A): expiry timestamps compare to NOW — the
        // caller passes `new Date().toISOString()`, never `now - TTL` (a lease
        // is reclaimable the moment it passes its TTL, not a full TTL later).
        const nowIso = new Date().toISOString();
        const reclaim = reclaimExpiredCohortRuns(
          this.workspaceId,
          nowIso,
          run => this.cohortCuration.verifyFrozen(run),
          this.workerId,
          COHORT_LEASE_TTL_MS,
        );
        if (reclaim.resumed.length > 0) {
          console.log(`[OnboardingWorker] Startup reclaim: resumed ${reclaim.resumed.length} expired cohort run(s): ${reclaim.resumed.map(r => r.id).join(', ')}`);
        }
        if (reclaim.superseded.length > 0) {
          console.warn(`[OnboardingWorker] Startup reclaim: superseded ${reclaim.superseded.length} drifted cohort run(s).`);
        }
        for (const run of reclaim.resumed) this.dispatchCohortRun(run);
      } catch (err) {
        console.error('[OnboardingWorker] Failed to reclaim expired cohort runs on startup:', err);
      }
    }

    this.interval = setInterval(() => this.poll(), 2000);
    console.log('[OnboardingWorker] Started stage-based worker loop');
  }

  stop(): void {
    // Reviewer P1 (epic #46 remediation): a `stopped` flag is set BEFORE the
    // interval is cleared so a poll already in flight when stop() is called
    // (e.g. a workspace switch in getWorker) refuses to keep mutating the old
    // workspace. Idempotent: safe to call multiple times.
    this.stopped = true;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    console.log('[OnboardingWorker] Stopped worker loop');
  }

  /** Await all in-flight processing promises (tests, graceful shutdown). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
  }

  async poll(): Promise<void> {
    if (this.stopped || this.isProcessing) return;
    this.isProcessing = true;

    try {
      // Epic #46 Phase 2 (automation-owned progression): automatic
      // continuation sweeps run on every poll so happy-path progression needs
      // ZERO manual advance clicks:
      //   1. Discovery-completed with a confirmed URL → Extraction;
      //      Extraction-completed with data → Curation (family barrier);
      //      Curation-completed (not semantic-blocked, parent terminal) →
      //      Review.
      //   2. Blocked Extraction items whose domain NOW has a usable extractor
      //      profile → re-queued (domain-level release; no per-SKU clicks).
      // Both are deterministic, idempotent, and fail closed into an
      // actionable state; a sweep failure never breaks the poll loop.
      try {
        const autoAdvance = sweepAutoAdvance(this.workspaceId);
        if (
          autoAdvance.discoveryToExtraction.length > 0 ||
          autoAdvance.extractionToCuration.length > 0 ||
          autoAdvance.curationToReview.length > 0
        ) {
          console.log(
            `[OnboardingWorker] Auto-advanced ${autoAdvance.extractionToCuration.length} extraction→curation, ` +
            `${autoAdvance.discoveryToExtraction.length} discovery→extraction, ` +
            `${autoAdvance.curationToReview.length} curation→review`,
          );
        }
      } catch (err) {
        console.error('[OnboardingWorker] Auto-advance sweep failed (non-blocking):', err);
      }
      try {
        const domainRelease = sweepDomainReleases(this.workspaceId);
        if (domainRelease.releasedIds.length > 0) {
          console.log(
            `[OnboardingWorker] Released ${domainRelease.releasedIds.length} extraction item(s) on domains with usable profiles: ` +
            `${domainRelease.domains.join(', ')}`,
          );
        }
      } catch (err) {
        console.error('[OnboardingWorker] Domain-release sweep failed (non-blocking):', err);
      }

      // Batches with in-flight (claimed) items — refreshed once per poll.
      const inFlightBatches = new Set<string>();

      // Process stages in priority order: discovery first, then extraction, then curation
      for (const stage of buildAutoStages()) {
        if (this.running.size >= this.maxConcurrency) break;

        // Extraction has a separate concurrency limit to avoid bot detection
        if (stage === 'collect_details' && this.extractionRunning >= this.maxExtractionConcurrency) continue;

        // PR3 M3 (issue #30): with the cohort flag active, Curation is
        // cohort-claimed EXCLUSIVELY — reclaim expired leases, reconcile
        // drift-before-claimable, claim ready cohorts and dispatch them to
        // the freeze/execute path. `claimItemsForProcessing('prepare_listing', ...)`
        // is NEVER called in this mode; Discovery/Extraction stay per-item.
        if (stage === 'prepare_listing' && isCohortCurationActive(getCohortCurationFlags())) {
          this.claimAndDispatchCohortRuns(inFlightBatches);
          continue;
        }
        // PR4 C5 (DECISION-E): shadow mode (`cohortCurationV2Enabled` ON +
        // `cohortShadowOnly`) — run the DETERMINISTIC-ONLY cohort Execution
        // Product Type resolution over ready cohorts, log the outcome, write
        // NOTHING (no runs claimed, no PR4 columns, no dependency rows, no
        // model calls). The legacy per-item Curation path below then runs
        // unchanged — byte-identical PR3 shadow semantics.
        if (stage === 'prepare_listing') {
          const curationFlags = getCohortCurationFlags();
          if (curationFlags.cohortCurationV2Enabled && curationFlags.cohortShadowOnly) {
            try {
              this.observeCohortTypeShadow();
            } catch (err) {
              console.error('[OnboardingWorker] Shadow cohort type observation failed (non-blocking):', err);
            }
          }
        }

        const available = this.maxConcurrency - this.running.size;
        const claimedItems = claimItemsForProcessing(stage, available, this.workspaceId, this.workerId);
        const dispatchableItems = this.holdWaitingFamilyMembers(stage, claimedItems);

        for (const item of dispatchableItems) {
          if (this.running.has(item.id)) {
            // Claim race resolution: `claimItemsForProcessing` already wrote
            // stage_status='in_progress' for this row, but the item is still
            // being processed by a PREVIOUS stage's task in the SAME poll
            // (e.g. sourcing just advanced it to discovery/pending). No task
            // will be dispatched for this claim, so restore the status it had
            // (pending) instead of leaving the item stranded in_progress
            // until a worker restart requeues it.
            getDb()
              .query(
                `UPDATE onboarding_items SET stage_status = 'pending', claimed_by = NULL, claimed_at = NULL
                 WHERE id = ? AND stage_status = 'in_progress'`,
              )
              .run(item.id);
            continue;
          }

          // Re-check extraction concurrency limit in loop since processItem increments it synchronously
          if (stage === 'collect_details' && this.extractionRunning >= this.maxExtractionConcurrency) {
            break;
          }

          inFlightBatches.add(item.batchId);

          const promise = this.processItem(item, stage);
          this.running.set(item.id, promise);
          promise.finally(() => this.running.delete(item.id));

          if (this.running.size >= this.maxConcurrency) break;
        }
      }

      // Issue #30 PR2: refresh candidate cohorts for every batch with in-flight
      // items (cheap, idempotent). Family readiness must stay current while
      // items are being processed; failures never block the worker loop.
      for (const batchId of inFlightBatches) {
        try {
          await refreshCandidateCohorts(this.workspaceId, batchId);
        } catch (err) {
          console.warn(`[OnboardingWorker] Candidate cohort refresh failed for batch ${batchId} (non-blocking):`, err);
        }
      }
    } catch (err) {
      console.error('[OnboardingWorker] Error in poll loop:', err);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Epic #46 audit fix (family barrier in DEFAULT legacy mode): per-item
   * Curation claiming must never start partial-family Curation.
   *
   * In the default configuration (cohort flags fully OFF — the ADR 0013
   * legacy per-item Curation path), any claimed `curation/pending` item that
   * is a member of an ACTIVE candidate cohort still `forming`/`waiting` is
   * released back to `curation/pending` (unclaimed) and never dispatched.
   * The item projects as Waiting-on-Family and becomes claimable once its
   * cohort transitions to `ready`.
   *
   * NOT applied when cohort Curation flags are ON (active mode owns cohort
   * claiming exclusively; shadow mode keeps the byte-identical PR3 legacy
   * path — it only observes). Singletons and members of ready cohorts are
   * never held. Idempotent and claim-owner-guarded (a concurrent rebind is
   * never clobbered). Emits an SSE `item:status` (pending, familyBarrier)
   * per held member so the UI + telemetry stay live.
   */
  private holdWaitingFamilyMembers(
    stage: PipelineStage,
    claimedItems: Array<{ id: string; batchId: string }>,
  ): Array<{ id: string; batchId: string }> {
    if (stage !== 'prepare_listing' || claimedItems.length === 0) return claimedItems;
    const flags = getCohortCurationFlags();
    // Active OR shadow mode: the cohort path (or its legacy sibling under
    // shadow observation) owns claiming — never hold here.
    if (flags.cohortCurationV2Enabled) return claimedItems;
    const waitingIds = new Set(listWaitingCohortMemberIdsByWorkspace(this.workspaceId));
    if (waitingIds.size === 0) {
      // Nothing waits right now — sync the tracked set so a future re-hold
      // of the same members emits again (they left and re-entered).
      this.lastHeldFamilyBarrierIds.clear();
      return claimedItems;
    }
    const dispatchable: Array<{ id: string; batchId: string }> = [];
    const heldNow = new Map<string, string>(); // itemId → batchId
    for (const item of claimedItems) {
      if (!waitingIds.has(item.id)) {
        dispatchable.push(item);
        continue;
      }
      if (releaseHeldFamilyClaim(item.id, this.workerId)) {
        heldNow.set(item.id, item.batchId);
      } else {
        // Claim lost the race — let the normal dispatch loop handle it.
        dispatchable.push(item);
      }
    }
    if (heldNow.size === 0) {
      // Members left the barrier (or the claim race resolved elsewhere):
      // sync tracking silently — nothing to announce.
      this.lastHeldFamilyBarrierIds.clear();
      return dispatchable;
    }
    // SSE + log only on CHANGE: newly held members emit once; members that
    // stayed held from a prior poll are silent (no per-poll refresh spam).
    const newlyHeld = [...heldNow.keys()].filter(id => !this.lastHeldFamilyBarrierIds.has(id));
    for (const id of newlyHeld) {
      onboardingEvents.emitItemStatus(heldNow.get(id)!, id, 'pending', {
        stage: 'prepare_listing',
        familyBarrier: true,
      });
    }
    if (newlyHeld.length > 0 || heldNow.size !== this.lastHeldFamilyBarrierIds.size) {
      console.log(
        `[OnboardingWorker] Held ${heldNow.size} family member(s) behind readiness barrier (curation/pending)` +
          (newlyHeld.length > 0 ? `; ${newlyHeld.length} newly held` : ''),
      );
    }
    this.lastHeldFamilyBarrierIds = new Set(heldNow.keys());
    return dispatchable;
  }

  // ─── Cohort-centric Curation V2 (issue #30, PR3 M3) ─────────────────────────

  /**
   * The cohort curation leg of `poll()` (flag ON + !shadowOnly only):
   * 1. reclaim expired cohort-run leases (live sibling recovery; reconcile
   *    drift BEFORE deciding claimability — D9);
   * 2. reconcile ready cohorts whose CURRENT terminal run no longer matches
   *    the frozen world (supersede opens the claim slot); a matching terminal
   *    run stays the current historical decision (no new run);
   * 3. claim ready curation cohorts and dispatch each to the freeze/execute
   *    path.
   *
   * Everything is best-effort — a failure here never breaks the poll loop,
   * and ordinary GET/read endpoints never mutate runs (D9: this runs ONLY in
   * the worker poll path).
   */
  private claimAndDispatchCohortRuns(inFlightBatches: Set<string>): void {
    try {
      // PR3 hardening (Commit A): expiry timestamps compare to NOW.
      const nowIso = new Date().toISOString();
      const reclaim = reclaimExpiredCohortRuns(
        this.workspaceId,
        nowIso,
        run => this.cohortCuration.verifyFrozen(run),
        this.workerId,
        COHORT_LEASE_TTL_MS,
      );
      if (reclaim.resumed.length > 0) {
        console.log(`[OnboardingWorker] Reclaimed ${reclaim.resumed.length} expired cohort run(s): ${reclaim.resumed.map(r => r.id).join(', ')}`);
        for (const run of reclaim.resumed) this.dispatchCohortRun(run, inFlightBatches);
      }
      if (reclaim.superseded.length > 0) {
        console.warn(`[OnboardingWorker] Superseded ${reclaim.superseded.length} drifted cohort run(s) during reclaim.`);
      }

      this.reconcileDriftedTerminalRuns();

      const available = this.maxConcurrency - this.running.size;
      if (available <= 0) return;
      const claimed = claimReadyCurationCohorts(this.workspaceId, available, this.workerId, COHORT_LEASE_TTL_MS);
      for (const run of claimed) this.dispatchCohortRun(run, inFlightBatches);
    } catch (err) {
      console.error('[OnboardingWorker] Cohort curation leg failed (non-blocking):', err);
    }
  }

  /**
   * D9 reconcile-before-claimable: for every READY cohort whose current
   * (non-superseded) run is in a terminal state, verify the frozen world
   * still matches (`verifyCohortRunFrozen`). Drift → supersede the old run
   * (opens the slot so the claim can create a fresh run); match → leave the
   * terminal run as the current historical decision (never re-claimed until
   * drift supersedes it). Never runs from read endpoints.
   *
   * PR3 hardening (Commit A, R5): a `cancelled` current run is a RETRYABLE
   * terminal — a cancelled pre-freeze run never carries frozen evidence (it
   * left `freezing` via `cancelFreezingRun` with NULL hashes), so it is
   * superseded unconditionally before claiming and the slot reopens. A
   * `failed`/completed run is re-verified against the frozen world as before.
   */
  private reconcileDriftedTerminalRuns(): void {
    const readyCohorts = listCohortsByWorkspace(this.workspaceId).filter(c => c.status === 'ready');
    for (const cohort of readyCohorts) {
      const members = getCohortMembers(cohort.id);
      const items = listItemsByBatch(cohort.batchId);
      const itemMap = new Map(items.map(i => [i.id, i]));
      const allPastCuration = members.length > 0 && members.every(m => {
        const it = itemMap.get(m.onboardingItemId);
        return it && (it.stage === 'review_listings' || it.stage === 'create_drafts');
      });
      if (allPastCuration) continue;

      const current = getCurrentCohortRun(cohort.id);
      if (!current || !COHORT_RUN_TERMINAL.has(current.status)) continue;
      // Cancelled ⇒ retryable: supersede so the claim slot reopens. This never
      // needs a frozen-world re-verification (there is no frozen world to
      // match — a cancelled pre-freeze run has no evidence snapshot).
      if (current.status === 'cancelled') {
        supersedeCohortRun(current.id, 'Cancelled run retry (slot reopen)');
        console.warn(`[OnboardingWorker] Superseded cancelled run ${current.id} for ready cohort ${cohort.id} — slot reopened.`);
        continue;
      }
      if (this.cohortCuration.verifyFrozen(current) === 'match') {
        // Frozen world still matches — the terminal run is the current
        // historical decision; a new run is NOT created.
        continue;
      }
      supersedeCohortRun(current.id, 'Authority drift during pre-claim reconciliation');
      console.warn(`[OnboardingWorker] Superseded drifted terminal run ${current.id} for ready cohort ${cohort.id}.`);
    }
  }

  /**
   * PR4 C5 shadow-mode observation (DECISION-E): compute the deterministic-only
   * cohort Execution Product Type resolution over every ready cohort and log a
   * structured `cohort_product_type_shadow` line (cohort id, outcome,
   * per-member ids/sources) on change. The observer writes NOTHING — no run
   * rows, no PR4 columns, no dependency rows, no model calls — and the log
   * line is the only artifact (byte-identical PR3 shadow behavior otherwise).
   */
  private observeCohortTypeShadow(): void {
    let observations: CohortShadowObservation[];
    try {
      observations = observeCohortShadowTypeResolution(this.workspaceId, this.workspacePath);
    } catch (err) {
      console.warn(`[OnboardingWorker] Shadow cohort type resolution failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const observation of observations) {
      const detail = observation.perMember
        .map(member =>
          `${member.onboardingItemId}${member.productSku ? `(${member.productSku})` : ''}:${member.productTypeId ?? 'abstained'}@${member.source ?? 'none'}`,
        )
        .join('; ');
      const line = `cohort_product_type_shadow: cohort=${observation.cohortId} outcome=${observation.outcome} members=[${detail}]`;
      if (this.shadowObservedOutcomes.get(observation.cohortId) === line) continue;
      this.shadowObservedOutcomes.set(observation.cohortId, line);
      console.log(line);

      // PR4 C5 + Package B: persist the changed observation (durable
      // shadow — one row per cohort per state CHANGE; the repo dedupes
      // against the latest row, so this is restart-safe). Best-effort:
      // a failed insert never breaks the per-item curation poll leg.
      try {
        this.persistShadowObservation(observation);
      } catch (err) {
        console.warn(`[OnboardingWorker] Shadow observation persist failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Package B: write one durable `cohort_shadow_observations` row. */
  private persistShadowObservation(observation: CohortShadowObservation): void {
    const cohort = getCohortById(observation.cohortId);
    const nonNullTypes = observation.perMember
      .map(member => member.productTypeId)
      .filter((id): id is string => id !== null && id !== undefined);
    // The deterministic aggregated Execution Product Type for coherent
    // outcomes = the most common non-null member type (the resolver does not
    // expose a single aggregate id; the mode is faithful for the observation).
    const executionTypeId =
      observation.outcome === 'coherent' || observation.outcome === 'coherent_with_abstentions'
        ? (() => {
            if (nonNullTypes.length === 0) return null;
            const counts = new Map<string, number>();
            for (const v of nonNullTypes) counts.set(v, (counts.get(v) ?? 0) + 1);
            let best: string | null = null;
            let bestCount = 0;
            for (const [v, c] of counts) if (c > bestCount) { best = v; bestCount = c; }
            return best;
          })()
        : null;
    insertCohortShadowObservationIfChanged({
      workspaceId: this.workspaceId,
      cohortId: observation.cohortId,
      groupKey: cohort?.groupKey ?? null,
      groupLabel: cohort?.groupLabel ?? null,
      status: cohort?.status ?? null,
      memberCount: observation.perMember.length,
      // The observer only processes READY, non-superseded cohorts — every
      // observed member is ready by construction.
      readyCount: observation.perMember.length,
      executionTypeId,
      productTypeConfidence: null, // shadow never computes a single confidence
      outcome: observation.outcome,
      membersJson: JSON.stringify(
        observation.perMember.map(member => ({
          onboardingItemId: member.onboardingItemId,
          productSku: member.productSku,
          productTypeId: member.productTypeId,
          source: member.source,
        })),
      ),
      groupingVersion: cohort?.groupingVersion ?? null,
      observedAt: new Date().toISOString(),
    });
  }

  /** Dispatch a claimed/resumed cohort run to the freeze + execute path. */
  private dispatchCohortRun(run: CohortRun, inFlightBatches?: Set<string>): void {
    if (this.running.has(run.id)) return;
    // Batch-state gate: cohort runs reach this point via claim, lease
    // reclaim, or startup reclaim — none of which read batch state. A run
    // whose owning batch is not active+running stays DORMANT here (never
    // failed): it remains claimed and a later reclaim re-evaluates once the
    // batch resumes. Mirrors the stage-leg gating in claimItemsForProcessing.
    try {
      const cohort = getCohortById(run.cohortId);
      if (cohort) {
        if (inFlightBatches) inFlightBatches.add(cohort.batchId);
        const batch = findBatchById(cohort.batchId);
        if (!batch || batch.status !== 'active' || batch.executionState !== 'running') {
          return;
        }
      }
    } catch { /* best-effort gate — never break the poll loop */ }
    const promise = this.processCohortRun(run);
    this.running.set(run.id, promise);
    promise.finally(() => this.running.delete(run.id));
  }

  /**
   * Execute one cohort run through the Cohort Curation execution seam:
   * `freezing` → freeze (CAS; superseded-on-drift is a normal outcome) →
   * `running` → process. Errors are logged and never break the poll loop;
   * a run that fails to freeze stays claimed and is recovered by a later
   * reclaim once its lease expires. The worker supplies no hashes,
   * projections, maps, or snapshots and sequences nothing itself.
   */
  private async processCohortRun(run: CohortRun): Promise<void> {
    if (process.env.BAYSTATE_CMS_DEBUG_WORKER) console.debug(`[OnboardingWorker] Processing cohort run ${run.id} (cohort ${run.cohortId}, status=${run.status})`);
    try {
      const disposition = await this.cohortCuration.executeClaim(run.id, this.workerId);
      if (!disposition.executed && disposition.disposition !== 'freeze-not-finalized') {
        console.warn(`[OnboardingWorker] Cohort run ${run.id} not executed (${disposition.disposition})`);
      } else if (!disposition.executed) {
        console.warn(`[OnboardingWorker] Cohort run ${run.id} freeze did not finalize`);
      }
    } catch (err) {
      console.error(`[OnboardingWorker] Cohort run ${run.id} failed:`, err);
    }
  }

  private async processItem(item: any, stage: PipelineStage): Promise<void> {
    if (process.env.BAYSTATE_CMS_DEBUG_WORKER) console.debug(`[OnboardingWorker] Processing ${item.name} (${item.upc}) in stage: ${stage} (claimed by ${this.workerId})`);

    onboardingEvents.emitItemStatus(item.batchId, item.id, 'in_progress', { stage });

    try {
      switch (stage) {
        case 'route_sources':
          await this.processSourcing(item);
          break;
        case 'find_product_page':
          await this.processDiscovery(item);
          break;
        case 'collect_details':
          await this.processExtraction(item);
          break;
        case 'prepare_listing':
          await this.processCuration(item);
          break;
        default:
          break;
      }
    } catch (err) {
      console.error(`[OnboardingWorker] Error in ${stage} for ${item.id}:`, err);
    }
  }

  /**
   * Sourcing worker leg (ADR 0014 Amendment A, flag-gated by `buildAutoStages`).
   *
   * Runs distributor lookups for the item's current sourcing generation,
   * reconciles the resulting evidence, computes the deterministic
   * distributor-record projection (the qualification authority), and routes:
   * qualified found evidence -> `distributor_record_to_extraction` (target
   * Extraction, source_type='distributor_record', null URL); accepted but
   * below the qualification floor -> `evidence_to_discovery`; only provider
   * errors -> `degraded_fallback_to_discovery`; no identifier / no enabled
   * connections / all `not_stocked` -> `fallback_to_discovery`; hard identity
   * conflicts -> `needs_input_conflict` (sourcing/needs_input). `bundle_to_curation`
   * is never written. MANUAL mode holds every non-conflict outcome at
   * sourcing/needs_input (server-derived qualification view; the operator
   * chooses the route); automatic mode applies the route table directly.
   * Marker-v0 (legacy) rows never receive distributor routing — they keep the
   * operator-controlled Continue-to-Discovery path.
   *
   * Deterministic re-run: when the current generation already has attempts
   * (a retried/partial run or a test seed), the engine is SKIPPED and the
   * existing attempts are reconciled (cache-before-lookup semantics).
   */
  private async processSourcing(item: any): Promise<void> {
    if (process.env.BAYSTATE_CMS_DEBUG_WORKER) console.debug(`[OnboardingWorker] Sourcing for ${item.name} (${item.upc})`);

    let generation: ReturnType<typeof getCurrentSourcingGeneration> | null = null;
    let decidedAt: string;

    const flags = getSourcingFlags();
    const automatic = isAutomaticMode(flags);
    const manual = isManualMode(flags);

    const complete = (
      route: SourcingDecision['route'] | SourcingDecisionV2['route'],
      decision: SourcingDecision | SourcingDecisionV2,
      targetStage: 'find_product_page' | 'collect_details' | 'route_sources',
    ): boolean => {
      if (!generation) return false;
      const res = completeSourcingWithDecision(item.id, decision, targetStage);
      if (!res.ok) {
        updateItemStageStatus(item.id, 'failed', `Sourcing completion failed: ${res.reason}`);
        onboardingEvents.emitItemStatus(item.batchId, item.id, 'failed', { stage: 'route_sources', error: res.reason });
        return false;
      }
      // Finalize the generation BEFORE the single terminal event: a failure
      // here falls into the outer catch and emits exactly ONE 'failed' event
      // (the 'completed' event below never fires).
      completeSourcingGeneration(generation.id, 'completed');
      onboardingEvents.emitItemStatus(item.batchId, item.id, route === 'needs_input_conflict' ? 'needs_input' : 'completed', {
        stage: 'route_sources',
        route,
      });
      return true;
    };

    /**
     * Builder slice B2: approved-strategy setup attention. An approved
     * generation with no usable/implemented source parks visibly at
     * needs_input — never an unapproved fallback, never fake evidence.
     * Mirrors the manual-hold decision shape (same route/stage).
     */
    const setupAttentionHold = (warnings: string[], providerIds: string[] = []): void => {
      updateItemStageStatus(item.id, 'needs_input', warnings[0] ?? 'Approved strategy has no usable source');
      complete(
        'needs_input_conflict',
        {
          schemaVersion: 2,
          route: 'needs_input_conflict',
          origin: 'automatic_policy',
          acceptedEvidenceAttemptIds: [],
          providerIds,
          conflicts: durableConflictsForDecision(item.id),
          warnings,
          decidedAt,
        },
        'route_sources',
      );
    };

    /** Manual mode hold: every non-conflict outcome waits at needs_input. */
    const manualHold = (warnings: string[], providerIds: string[] = []): void => {
      updateItemStageStatus(item.id, 'needs_input', 'Manual mode: awaiting operator route selection');
      complete(
        'needs_input_conflict',
        {
          schemaVersion: 2,
          route: 'needs_input_conflict',
          origin: 'automatic_policy',
          acceptedEvidenceAttemptIds: [],
          providerIds,
          // Durable conflicts (epic #46 follow-up): the decision payload must
          // reference the persisted conflicts instead of an empty array — the
          // V2 schema requires ≥1 hard conflict on this route and the empty
          // array contradicted the durable evidence-conflict table.
          conflicts: durableConflictsForDecision(item.id),
          warnings: [...warnings, 'Manual mode: operator must choose the route (Use distributor record / Continue to Discovery)'],
          decidedAt,
        },
        'route_sources',
      );
    };

    /**
     * Durable conflicts → decision-payload shape (epic #46 follow-up). The
     * authoritative conflict set lives in `onboarding_evidence_conflicts`
     * (written by reconciliation); the decision JSON now carries the same
     * field/severity/provider-value mapping instead of a contradictory
     * empty array. Unresolvable provider ids fall back to the evidence
     * attempt id (never a blank key). HARD-only: soft disagreements on
     * reference/copy fields are consolidated by the projection authority
     * and never enter decision payloads (the needs_input_conflict route
     * requires ≥1 hard conflict anyway).
     */
    const durableConflictsForDecision = (itemId: string): SourcingConflict[] => {
      const attempts = getCurrentGenerationAttempts(itemId);
      const providerByAttempt = new Map(attempts.map(a => [a.id, a.providerId]));
      return listCurrentGenerationConflictsForItem(itemId)
        .filter(c => c.severity === 'hard')
        .map(c => ({
        field: c.field,
        severity: c.severity,
        providerValues: Object.fromEntries(
          c.candidates.map(cand => {
            let value: string;
            try {
              const parsed = JSON.parse(cand.valueJson) as unknown;
              value = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
            } catch {
              value = cand.valueJson;
            }
            return [providerByAttempt.get(cand.evidenceAttemptId) ?? cand.evidenceAttemptId, value];
          }),
        ),
      }));
    };

    /**
     * Per-provider source-error warnings for the decision audit (MC review
     * fix): a qualified record WITH a provider error must retain the error.
     * `not_stocked` is NOT an error and stays silent.
     */
    const sourceErrorWarnings = (attemptsList: Array<{
      outcome: string;
      providerId: string;
      errorCode: string | null;
      errorMessage: string | null;
    }>): string[] =>
      attemptsList
        .filter((a) => a.outcome === 'source_error')
        .map((a) => {
          const code = a.errorCode ?? 'source_error';
          const cleanMsg = a.errorMessage ? a.errorMessage.replace(/\s+/g, ' ').trim() : '';
          const truncated = cleanMsg.length > 200 ? `${cleanMsg.slice(0, 197)}...` : cleanMsg;
          const detail = truncated ? `: ${truncated}` : '';
          const warning = `Distributor ${a.providerId} lookup failed (${code}${detail})`;
          return warning.length > 480 ? `${warning.slice(0, 477)}...` : warning;
        });

    try {
      // Everything that can fail lives inside the failure boundary: engine
      // construction and generation load/create included.
      const engine = this.engineFactory ? this.engineFactory() : new DefaultSourcingEngine();
      generation = getCurrentSourcingGeneration(item.id) ?? startSourcingGeneration(item.id, 'automatic');
      decidedAt = new Date().toISOString();

      // Marker-v0 rows are excluded by the claim filter; belt-and-suspenders:
      // they never receive automatic distributor routing or decisions.
      if (!isCurrentSourcingEntryPolicy(item.sourcingEntryPolicyVersion)) {
        complete(
          'fallback_to_discovery',
          {
            schemaVersion: 2,
            route: 'fallback_to_discovery',
            origin: 'automatic_policy',
            acceptedEvidenceAttemptIds: [],
            providerIds: [],
            sourcingGenerationId: generation.id,
            sourceType: 'official_page',
            target: 'discovery',
            conflicts: [],
            warnings: ['Legacy item excluded from automatic distributor routing (entry policy 0)'],
            decidedAt,
          },
          'find_product_page',
        );
        return;
      }

      // Amendment B1.1 (issue #150): a generation holding a retired v1
      // advisory pin predates query-all routing and must never execute,
      // reconcile, or slip through existing-evidence reuse or the automatic
      // no-identifier/no-connection fallbacks below. Park visibly; the
      // operator retries explicitly (a fresh generation captures query-all
      // or the current approval). Scoped to captured retired/invalid
      // bindings only — generations without a binding keep the existing
      // missing-binding/no-current-approval legacy reuse contract.
      // getGenerationStrategyBinding returns null when no row exists
      // (fresh work proceeds) and throws only on a corrupt captured row.
      try {
        if (isRetiredStrategyBinding(getGenerationStrategyBinding(generation.id))) {
          setupAttentionHold(['This generation used retired brand routing settings. Retry to start a new generation under query-all routing.']);
          return;
        }
      } catch {
        setupAttentionHold(['Strategy binding is invalid for this generation; retry in a new generation']);
        return;
      }

      // Deterministic re-run: reuse existing current-generation attempts.
      if (getCurrentGenerationAttempts(item.id).length === 0) {
        if (normalizeGtin(item.upc) === null) {
          // No usable identifier -> audited pass-through (never a brand-only
          // lookup). Checked BEFORE connections so the warning is truthful.
          if (manual) {
            manualHold(['Item has no UPC/GTIN for distributor lookup']);
          } else {
            complete(
              'fallback_to_discovery',
              {
                schemaVersion: 2,
                route: 'fallback_to_discovery',
                origin: 'automatic_policy',
                acceptedEvidenceAttemptIds: [],
                providerIds: [],
                sourcingGenerationId: generation.id,
                sourceType: 'official_page',
                target: 'discovery',
                conflicts: [],
                warnings: ['Item has no UPC/GTIN for distributor lookup'],
                decidedAt,
              },
              'find_product_page',
            );
          }
          return;
        }

        const enabledConnections = listConnectionsByWorkspace(this.workspaceId, true);
        if (enabledConnections.length === 0) {
          // Builder slice B2: an approved strategy pins the collection
          // boundary — zero usable connections is setup attention, never an
          // unapproved fallback to arbitrary official discovery. Ticket
          // #123: approved official_page sources need no distributor
          // connection, so they proceed to the engine instead of holding.
          const approvedForHold = getApprovedBrandStrategy(this.workspaceId, item.brandHint ?? null);
          const holdHasOfficial = (approvedForHold?.sources ?? []).some((s) => s.kind === 'official_page');
          if (approvedForHold && !holdHasOfficial) {
            setupAttentionHold([`Approved strategy revision ${approvedForHold.revision} has no usable distributor connection`]);
            return;
          }
          if (approvedForHold && holdHasOfficial) {
            // Fall through to engine execution for the official legs.
          } else {
          // Zero enabled connections -> audited automatic pass-through.
          if (manual) {
            manualHold(['No enabled distributor connections']);
          } else {
            complete(
              'fallback_to_discovery',
              {
                schemaVersion: 2,
                route: 'fallback_to_discovery',
                origin: 'automatic_policy',
                acceptedEvidenceAttemptIds: [],
                providerIds: [],
                sourcingGenerationId: generation.id,
                sourceType: 'official_page',
                target: 'discovery',
                conflicts: [],
                warnings: ['No enabled distributor connections'],
                decidedAt,
              },
              'find_product_page',
            );
          }
          return;
          }
        }

        // Builder slice B2: the engine result is consumed, not discarded.
        // An approved generation with no usable/implemented source parks in
        // setup attention; a corrupt/uncertain binding fails closed here.
        const runResult = await engine.runGeneration({
          itemId: item.id,
          generationId: generation.id,
          workspaceId: this.workspaceId,
          upc: String(item.upc),
          gtin: null,
          brandHint: item.brandHint ?? null,
          signal: AbortSignal.timeout(60_000),
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        });
        if (runResult.skipped.some((s) => s.reason === 'strategy_binding_invalid')) {
          setupAttentionHold(['Strategy binding is invalid or uncertain; retry in a new generation']);
          return;
        }
        if (runResult.skipped.some((s) => s.reason === 'strategy_binding_policy_retired')) {
          setupAttentionHold(['This generation used retired brand routing settings. Retry to start a new generation under query-all routing.']);
          return;
        }
        if (runResult.strategyRevision != null && runResult.attempts.length === 0) {
          setupAttentionHold([`Approved strategy revision ${runResult.strategyRevision} produced no usable evidence; retry in a new generation`]);
          return;
        }
      }

      // Builder slice B2 (review-loop R1 P1-1): the reuse path pins the
      // boundary too, but only where a boundary exists to bypass. The engine
      // is the sole binding capturer and only runs on fresh generations, so
      // a current generation that already holds evidence but no binding
      // while an approved strategy exists is pre-builder work that predates
      // the approval — park visibly instead of reconciling under a boundary
      // that was never pinned. Generations without any approval keep legacy
      // reuse (a later fresh generation captures its own binding).
      if (getCurrentGenerationAttempts(item.id).length > 0) {
        const approvedForReuse = getApprovedBrandStrategy(this.workspaceId, item.brandHint ?? null);
        if (approvedForReuse) {
          let reuseBindingOk = false;
          try {
            reuseBindingOk = getGenerationStrategyBinding(generation.id) !== null;
          } catch {
            reuseBindingOk = false;
          }
          if (!reuseBindingOk) {
            setupAttentionHold(['Strategy binding is missing or invalid for this generation; retry in a new generation']);
            return;
          }
        }
      }

      // CURRENT-GENERATION CAS (ADR 0014): a retry that superseded this
      // generation while the engine ran must not let this (stale) worker
      // route the item. Abort quietly — the item stays sourcing/pending for
      // the NEW generation's worker.
      if (getCurrentSourcingGeneration(item.id)?.id !== generation.id) {
        console.log(`[OnboardingWorker] Sourcing generation ${generation.id} superseded during run for ${item.id} — abandoning stale routing`);
        // Release the claim: the item returns to pending so the NEW
        // generation's worker can claim and route it.
        updateItemStageStatus(item.id, 'pending', null);
        return;
      }

      // Ticket #123: resume unfinished official legs. Engine execution was
      // skipped above (attempts already exist), but an approved
      // official-bearing boundary whose planned official sources lack
      // terminal attempts is INTERRUPTED, not complete — re-run the engine
      // (idempotent legs skip finished sources) instead of reconciling
      // partial evidence. Monotonic: every run persists terminal outcomes
      // or parks, so this cannot loop forever. Distributor-only and legacy
      // boundaries keep the existing reuse contract below.
      if (getCurrentGenerationAttempts(item.id).length > 0) {
        let resumeBinding: import('../db/repositories/brand-strategy-generation-repo').GenerationStrategyBinding | null = null;
        try {
          resumeBinding = getGenerationStrategyBinding(generation.id);
        } catch {
          resumeBinding = null;
        }
        const resumeOfficial = (resumeBinding?.mode === 'approved' ? resumeBinding.sources : [])
          .filter((s) => s.kind === 'official_page' && (s as { domain?: string | null }).domain)
          .map((s) => ((s as { domain?: string | null }).domain as string).toLowerCase());
        if (resumeOfficial.length > 0) {
          let envelopeDone = false;
          try {
            getStrategyCollectionResult(generation.id);
            envelopeDone = true;
          } catch {
            envelopeDone = false;
          }
          if (!envelopeDone) {
            const officialDone = new Set(
              getCurrentGenerationAttempts(item.id)
                .filter((a) => (a.providerId ?? '').toLowerCase().startsWith('official_page:'))
                .map((a) => (a.providerId as string).slice('official_page:'.length).toLowerCase()),
            );
            if (resumeOfficial.some((d) => !officialDone.has(d))) {
              const resumeResult = await engine.runGeneration({
                itemId: item.id,
                generationId: generation.id,
                workspaceId: this.workspaceId,
                upc: String(item.upc),
                gtin: null,
                brandHint: item.brandHint ?? null,
                signal: AbortSignal.timeout(60_000),
                deadlineAt: new Date(Date.now() + 60_000).toISOString(),
              });
              if (resumeResult.skipped.some((s) => s.reason === 'strategy_binding_invalid')) {
                setupAttentionHold(['Strategy binding is invalid or uncertain; retry in a new generation']);
                return;
              }
              if (resumeResult.skipped.some((s) => s.reason === 'strategy_binding_policy_retired')) {
                setupAttentionHold(['This generation used retired brand routing settings. Retry to start a new generation under query-all routing.']);
                return;
              }
              if (getCurrentSourcingGeneration(item.id)?.id !== generation.id) {
                console.log(`[OnboardingWorker] Sourcing generation ${generation.id} superseded during resume for ${item.id} — abandoning stale routing`);
                updateItemStageStatus(item.id, 'pending', null);
                return;
              }
            }
          }
        }
      }

      const attempts = getCurrentGenerationAttempts(item.id);

      // Connector-declared variant axes (Amendment A): collected from the
      // persisted attempts' declarations so custom axes are hard identity
      // fields for this generation.
      const declaredVariantAxes = Array.from(
        new Set(attempts.flatMap((a) => (a.variantAxisDeclarations ?? []).map((d) => d.normalizedAxis))),
      );

      const reconcile = await reconcileDistributorEvidence(item.id, attempts, generation.id, declaredVariantAxes);

      // Second CAS check after reconcile: supersede during reconciliation
      // also aborts stale routing.
      if (getCurrentSourcingGeneration(item.id)?.id !== generation.id) {
        console.log(`[OnboardingWorker] Sourcing generation ${generation.id} superseded during reconcile for ${item.id} — abandoning stale routing`);
        updateItemStageStatus(item.id, 'pending', null);
        return;
      }

      // Deterministic qualification authority (Amendment A): the projection
      // floor (exact identifier, current-generation accepted evidence, ≥1
      // nonblank name, complete provenance, no open hard conflict) decides
      // whether Discovery may be skipped.
      const projection = buildDistributorRecordProjection({
        itemId: item.id,
        itemUpc: String(item.upc),
        sourcingGenerationId: generation.id,
        attempts,
        acceptedAttemptIds: reconcile.acceptedAttemptIds,
        declaredVariantAxes,
        resolutions: [],
      });

      if (reconcile.hasHardIdentityConflict) {
        updateItemStageStatus(item.id, 'needs_input', 'Identity conflict detected');
        complete(
          'needs_input_conflict',
          {
            schemaVersion: 2,
            route: 'needs_input_conflict',
            origin: 'automatic_policy',
            acceptedEvidenceAttemptIds: [],
            providerIds: reconcile.providerIds,
            sourcingGenerationId: generation.id,
            sourceType: 'official_page',
            target: 'sourcing',
            // Epic #46 follow-up: reference the durable conflicts (the V2
            // schema requires ≥1 hard conflict; the old empty array
            // contradicted the persisted evidence-conflict rows).
            conflicts: durableConflictsForDecision(item.id),
            warnings: reconcile.warnings,
            decidedAt,
          },
          'route_sources',
        );
        return;
      }

      if (!automatic) {
        // MANUAL mode: hold every non-conflict outcome for the operator. The
        // server-derived qualification view (qualified? ids/hash/providers)
        // is computed by the item-detail projection, not the decision.
        // Persist relational acceptances FIRST (MC review fix) so
        // completeSourcingViaProjection can recompute qualification when the
        // operator chooses "Use distributor record" (the V2 needs_input
        // decision schema forbids accepted ids — the acceptances table is
        // the authority).
        if (projection.qualified) {
          recordAcceptances(item.id, projection.acceptedAttemptIds, 'system', 'qualified distributor record (manual review)');
        } else if (reconcile.acceptedAttemptIds.length > 0) {
          recordAcceptances(item.id, reconcile.acceptedAttemptIds, 'system', 'coherent distributor evidence (manual review)');
        }
        manualHold([...reconcile.warnings, ...sourceErrorWarnings(attempts)], reconcile.providerIds);
        return;
      }

      // AUTOMATIC mode route table (Amendment A).
      // Tickets #122/#123: approved strategy boundaries finalize the
      // completed-collection envelope BEFORE onward routing, then stay
      // inside Collect details (never Discovery for these boundaries).
      // Distributor-only boundaries keep the qualified-evidence contract;
      // mixed (official-bearing) boundaries ALWAYS take the envelope path —
      // even when their distributor projection qualifies — so official
      // contributions are never discarded by a distributor-only decision.
      // Scoped to approved bindings whose frozen sources are ALL known
      // kinds (the general post-attempt boundary fix stays separate).
      let strategyBoundary: { mixed: boolean } | null = null;
      try {
        const strategyBinding = getGenerationStrategyBinding(generation.id);
        if (
          strategyBinding?.mode === 'approved' &&
          strategyBinding.sources.length > 0 &&
          strategyBinding.sources.every((s) => s.kind === 'distributor_record' || s.kind === 'official_page')
        ) {
          strategyBoundary = { mixed: strategyBinding.sources.some((s) => s.kind === 'official_page') };
        }
      } catch {
        strategyBoundary = null;
      }
      if (strategyBoundary) {
        let finalizedEnvelope: { envelope: StrategyCollectionResult; hash: string };
        try {
          finalizedEnvelope = finalizeStrategyCollectionForGeneration({
            workspaceId: this.workspaceId,
            itemId: item.id,
            generationId: generation.id,
          });
        } catch (err) {
          const code = err instanceof Error ? (err as Error & { code?: string }).code ?? 'finalize_failed' : 'finalize_failed';
          setupAttentionHold([`Strategy collection could not complete (${code}); retry in a new generation`]);
          return;
        }
        // Ticket #123: a completed envelope with nothing usable AND no
        // distributor attempt at all is not enrichable preparation input —
        // it is a setup problem (e.g. official-only boundary with no
        // healthy profile). Park visibly instead of preparing from pure
        // spreadsheet identity. Any distributor attempt (even not_stocked)
        // or any usable contribution proceeds to preparation.
        const envelopeUsable = usableContributions(finalizedEnvelope.envelope);
        const hasDistributorAttempts = attempts.some((a) => a.distributorConnectionId != null);
        if (envelopeUsable.length === 0 && !hasDistributorAttempts) {
          const unusable = finalizedEnvelope.envelope.contributions
            .map((c) => `${c.providerId} (${c.reasonCode ?? c.outcome})`)
            .sort()
            .join('; ');
          setupAttentionHold([`Approved strategy has no usable sources to collect from: ${unusable || 'no usable sources'}`]);
          return;
        }
        if (projection.qualified && !strategyBoundary.mixed) {
          recordAcceptances(item.id, projection.acceptedAttemptIds, 'system', 'qualified distributor record');
          complete(
            'distributor_record_to_extraction',
            {
              schemaVersion: 2,
              route: 'distributor_record_to_extraction',
              origin: 'automatic_policy',
              acceptedEvidenceAttemptIds: projection.acceptedAttemptIds,
              providerIds: projection.providerIds,
              sourcingGenerationId: generation.id,
              conflicts: [],
              warnings: [...reconcile.warnings, ...sourceErrorWarnings(attempts)],
              decidedAt,
              evidenceHash: projection.evidenceHash,
              sourceType: 'distributor_record',
              target: 'extraction',
            },
            'collect_details',
          );
          return;
        }
        // Accepted-but-insufficient OR started-and-exhausted: the completed
        // envelope (never attempts alone) proves completion and routes to
        // Collect details for consolidation / preparation-gap assessment.
        if (reconcile.acceptedAttemptIds.length > 0) {
          recordAcceptances(item.id, reconcile.acceptedAttemptIds, 'system', 'coherent distributor evidence (strategy collection)');
        }
        complete(
          'completed_strategy_collection',
          {
            schemaVersion: 2,
            route: 'completed_strategy_collection',
            origin: 'automatic_policy',
            acceptedEvidenceAttemptIds: [...new Set(reconcile.acceptedAttemptIds)].sort(),
            providerIds: [...new Set(reconcile.providerIds)].sort(),
            sourcingGenerationId: generation.id,
            evidenceHash: finalizedEnvelope.hash,
            sourceType: 'distributor_record',
            target: 'extraction',
            conflicts: [],
            warnings: [...reconcile.warnings, ...sourceErrorWarnings(attempts)],
            decidedAt,
          },
          'collect_details',
        );
        return;
      }
      if (projection.qualified) {
        recordAcceptances(item.id, projection.acceptedAttemptIds, 'system', 'qualified distributor record');
        complete(
          'distributor_record_to_extraction',
          {
            schemaVersion: 2,
            route: 'distributor_record_to_extraction',
            origin: 'automatic_policy',
            acceptedEvidenceAttemptIds: projection.acceptedAttemptIds,
            providerIds: projection.providerIds,
            sourcingGenerationId: generation.id,
            conflicts: [],
            warnings: [...reconcile.warnings, ...sourceErrorWarnings(attempts)],
            decidedAt,
            evidenceHash: projection.evidenceHash,
            sourceType: 'distributor_record',
            target: 'extraction',
          },
          'collect_details',
        );
        return;
      }

      if (reconcile.acceptedAttemptIds.length > 0) {
        recordAcceptances(item.id, reconcile.acceptedAttemptIds, 'system', 'coherent distributor evidence');
        complete(
          'evidence_to_discovery',
          {
            schemaVersion: 2,
            route: 'evidence_to_discovery',
            origin: 'automatic_policy',
            acceptedEvidenceAttemptIds: reconcile.acceptedAttemptIds,
            providerIds: reconcile.providerIds,
            sourcingGenerationId: generation.id,
            sourceType: 'official_page',
            target: 'discovery',
            conflicts: [],
            warnings: [...reconcile.warnings, ...sourceErrorWarnings(attempts)],
            decidedAt,
          },
          'find_product_page',
        );
        return;
      }

      if (attempts.some((a) => a.outcome === 'source_error')) {
        complete(
          'degraded_fallback_to_discovery',
          {
            schemaVersion: 2,
            route: 'degraded_fallback_to_discovery',
            origin: 'automatic_policy',
            acceptedEvidenceAttemptIds: [],
            providerIds: reconcile.providerIds,
            sourcingGenerationId: generation.id,
            sourceType: 'official_page',
            target: 'discovery',
            conflicts: [],
            warnings: [...reconcile.warnings, 'Distributor lookups failed; continuing to Discovery'],
            decidedAt,
          },
          'find_product_page',
        );
        return;
      }

      // No found evidence / all not_stocked.
      complete(
        'fallback_to_discovery',
        {
          schemaVersion: 2,
          route: 'fallback_to_discovery',
          origin: 'automatic_policy',
          acceptedEvidenceAttemptIds: [],
          providerIds: reconcile.providerIds,
          sourcingGenerationId: generation.id,
          sourceType: 'official_page',
          target: 'discovery',
          conflicts: [],
          warnings: reconcile.warnings,
          decidedAt,
        },
        'find_product_page',
      );
    } catch (err) {
      console.error(`[OnboardingWorker] Sourcing error for ${item.id}:`, err);
      updateItemStageStatus(item.id, 'failed', String(err));
      // Mark the generation failed when one exists (a setup failure before
      // generation creation leaves none).
      if (generation) {
        try {
          completeSourcingGeneration(generation.id, 'failed');
        } catch {
          // best effort — the item status + event are the contract
        }
      }
      onboardingEvents.emitItemStatus(item.batchId, item.id, 'failed', {
        stage: 'route_sources',
        error: String(err),
      });
    }
  }


  private async processDiscovery(item: any): Promise<void> {
    if (process.env.BAYSTATE_CMS_DEBUG_WORKER) console.debug(`[OnboardingWorker] Discovery for ${item.name} (${item.upc})`);

    // Observe mode (Amendment A, MC): shadow distributor data collection for
    // current-policy imports. Observation NEVER writes conflicts/acceptances/
    // decisions/transitions, and an observation failure NEVER becomes a
    // Discovery failure (Discovery proceeds normally).
    const sourcingFlags = getSourcingFlags();
    if (isObserveMode(sourcingFlags) && isCurrentSourcingEntryPolicy(item.sourcingEntryPolicyVersion)) {
      try {
        const engine = this.engineFactory ? this.engineFactory() : new DefaultSourcingEngine();
        await observeSourcingCandidates({ item, workspaceId: this.workspaceId, engine });
      } catch (err) {
        console.error(`[OnboardingWorker] Observation failed for ${item.id}:`, err);
      }
    }

    // Protected discovery calls route through the frozen classification
    // model policy (issue #17 item A). No valid policy ⇒ disabled ⇒ the
    // discovery helpers use deterministic fallbacks.
    const policySnapshot = captureModelPolicySnapshot(this.workspacePath, undefined, this.workspaceId);

    // Discovery run traceability (epic #46 batch-analysis follow-up): one run
    // row per discovery execution, stamped onto every candidate source, so
    // the pipeline is auditable end-to-end (what was searched, which step
    // failed, which outcome was applied).
    let discoveryRunId: string | null = null;

    try {
      discoveryRunId = createDiscoveryRun(item.id, {
        trigger: 'automatic',
        upc: String(item.upc ?? ''),
        name: item.name ?? '',
        brandHint: item.brandHint ?? null,
      });
      const discover = this.deps?.discoverSources ?? discoverSources;
      const earlyOfficialDomains = getOfficialDomainsForBrand(item.brandHint ?? null);
      const variantNetworkFetch = createVariantDiscoveryFetch(earlyOfficialDomains);
      const discoveryFetch = createDiscoveryFetch(earlyOfficialDomains);
      const discovery = await discover(item.upc, item.name, item.brandHint, {
        price: item.price ? parseFloat(item.price) : null,
        modelPolicy: policySnapshot.state === 'configured' ? policySnapshot.view : null,
        networkFetch: discoveryFetch,
        variantNetworkFetch: variantNetworkFetch,
      });
      const sources = discovery.candidates;
      const consolidatedName = discovery.consolidatedName;

      // Brands and their official domains are operator-configured inputs
      // (brand_sites); discovery never infers or persists a brand mapping.
      const activeBrandHint = item.brandHint;

      // ── Authority snapshot ──────────────────────────────────────────────
      // The official-domain set that may authorize auto-accept THIS run,
      // paired against the item's configured brand hint.
      const officialDomains = getOfficialDomainsForBrand(activeBrandHint);

      // ── Hold on discovery if brand has no domain ───────────────────────
      if (discovery.noDomainMapped) {
        console.log(`[OnboardingWorker] ⚠ Brand "${activeBrandHint}" has no official domain configured. Parking item in Discovery stage.`);
        deleteSourcesByItem(item.id);
        if (sources.length > 0) {
          insertSources(item.id, sources);
        }
        completeDiscoveryRun(
          discoveryRunId,
          'needs_input_setup',
          `No official domain mapped for brand "${activeBrandHint}" — map a domain in Settings to complete discovery`,
        );

        const reviewReason = `needs_review: no domain mapped for brand "${activeBrandHint}" — map a domain in Settings to complete discovery`;
        updateItemStageStatus(item.id, 'completed', reviewReason);

        onboardingEvents.emitItemStatus(item.batchId, item.id, 'completed', {
          stage: 'find_product_page',
          needsManualReview: true,
          manualReviewReason: reviewReason,
          sourcesCount: sources.length,
          sitemapMatched: false,
          sitemapCandidateCount: 0,
        });
        return;
      }

      // ── Variant resolution durable state for Choose Variant (M1/P1) ──
      // When resolver reports ambiguous/no_match/stale/too_many in active mode, park for operator choice
      const variantResolutionForDiscovery = (discovery as any).variantResolution as { status: string; selectedKey: string | null; candidatesCount: number; overflow: boolean; warnings: string[]; identityHash: string | null; matrixCandidates?: import('../shared/schemas/variant-resolution').NormalizedVariantCandidate[] } | null | undefined;
      if (
        variantResolutionForDiscovery &&
        ['ambiguous', 'no_match', 'stale', 'stale_selection', 'too_many_variants', 'unsupported'].includes(variantResolutionForDiscovery.status) &&
        getEffectiveVariantResolutionMode() === 'active'
      ) {
        try {
          const db = getDb();
          const repo = createVariantResolutionRepo(db);
          const cur = repo.getCurrentForItem(item.id);
          if (cur) repo.supersedeCurrent(item.id, new Date().toISOString());
          const now = new Date().toISOString();
          const hash = variantResolutionForDiscovery.identityHash && /^[a-f0-9]{64}$/.test(variantResolutionForDiscovery.identityHash)
            ? variantResolutionForDiscovery.identityHash
            : 'f'.repeat(64);
          // Persist candidates: prefer canonical matrix candidates with real variantKey/identifiers (P1-1) so Choose Variant selection's variantKey matches live canonical lookup at extract.ts 103-117; fallback to minimal placeholder only when matrix unavailable
          const rawMatrixCandidates = (variantResolutionForDiscovery as any)?.matrixCandidates as import('../shared/schemas/variant-resolution').NormalizedVariantCandidate[] | undefined;
          const candidatesForRow = rawMatrixCandidates && rawMatrixCandidates.length > 0
            ? rawMatrixCandidates.slice(0, 250).map((c) => ({
                variantKey: c.variantKey,
                platformId: c.platformId,
                title: c.title,
                identifiers: c.identifiers,
                options: c.options,
                available: c.available,
                price: c.price,
                currency: c.currency,
                weight: c.weight,
                dimensions: c.dimensions,
                images: c.images,
                deepLink: c.deepLink,
                sourcePaths: c.sourcePaths,
              }))
            : sources.length > 0
              ? sources.slice(0, 250).map((s, idx) => ({
                  variantKey: `variant-${idx}`,
                  platformId: null,
                  title: s.title || s.url,
                  identifiers: [],
                  options: [],
                  available: true,
                  price: null,
                  currency: null,
                  weight: null,
                  dimensions: null,
                  images: [],
                  deepLink: s.url,
                  sourcePaths: {},
                }))
              : [];
          const canonicalParentKey = sources[0]?.url ?? item.sourceUrl ?? `discovery:${item.id}`;
          repo.create({
            id: `vr-disc-${item.id}-${Date.now()}`,
            onboarding_item_id: item.id,
            source_url: sources[0]?.url ?? canonicalParentKey,
            canonical_parent_key: canonicalParentKey,
            platform: 'shopify',
            parser_version: 1,
            identity_matrix_hash: hash,
            source_content_hash: null,
            status: variantResolutionForDiscovery.status === 'stale' || variantResolutionForDiscovery.status === 'stale_selection' ? 'stale' : (variantResolutionForDiscovery.status as any),
            reason_codes_json: JSON.stringify(variantResolutionForDiscovery.warnings?.length ? variantResolutionForDiscovery.warnings : [variantResolutionForDiscovery.status]),
            candidates_json: JSON.stringify(candidatesForRow),
            automatic_variant_key: null,
            selected_variant_key: null,
            decision_origin: null,
            decided_at: null,
            superseded_at: null,
            created_at: now,
            updated_at: now,
          });
        } catch (e) {
          console.warn('[OnboardingWorker] Failed to persist variant resolution for Discovery ambiguous', e);
        }
        deleteSourcesByItem(item.id);
        if (sources.length > 0) insertSources(item.id, sources);
        if (discoveryRunId) completeDiscoveryRun(discoveryRunId, 'needs_input_ambiguous', `Variant resolution ${variantResolutionForDiscovery.status} — needs operator choice`);
        updateItemStageStatus(item.id, 'needs_input', `variant:${variantResolutionForDiscovery.status}: multiple variants require operator choice`);
        onboardingEvents.emitItemStatus(item.batchId, item.id, 'needs_input', { stage: 'find_product_page', variantResolution: variantResolutionForDiscovery });
        return;
      }

      // ── Sitemap signals ──────────────────────────────────────────────
      // Sitemap candidates come from the brand's own sitemap (sourceMethod
      // starting with 'sitemap_'). Used by the auto-selection policy below
      // and surfaced to the UI via the SSE event so reviewers can see when
      // the sitemap pass produced hits.
      // Count sitemap-derived candidates, including those whose sourceMethod
      // was rewritten to 'shopify_variant' but carry originalSourceMethod in
      // their metadataJson (preserving correct reporting).
      const sitemapCandidates = sources.filter(s => {
        const method = s.sourceMethod ?? '';
        if (method.startsWith('sitemap_')) return true;
        if (method === 'shopify_variant' && s.metadataJson) {
          try {
            const meta = JSON.parse(s.metadataJson);
            return (meta.originalSourceMethod ?? '').startsWith('sitemap_');
          } catch { /* corrupt metadata — skip */ }
        }
        return false;
      });
      const sitemapCandidateCount = sitemapCandidates.length;
      const sitemapMatched = sitemapCandidateCount > 0;
      if (sitemapMatched) updateDiscoveryRunStep(discoveryRunId, 'sitemap_match');

      // ── Log result summary ─────────────────────────────────────────────
      if (sources.length > 0) {
        const bestSource = sources[0];
        console.log(
          `[OnboardingWorker] ✓ Discovery complete for "${item.name}" (${item.upc}): ` +
          `${sources.length} source(s) found (${sitemapCandidateCount} from sitemap). Top candidate: ${bestSource.url} (${(bestSource.confidence * 100).toFixed(0)}% confidence, domain: ${bestSource.domain ?? 'n/a'})`
        );
      } else {
        console.log(`[OnboardingWorker] ✗ Discovery complete for "${item.name}" (${item.upc}): 0 sources found.`);
      }

      deleteSourcesByItem(item.id);

      if (sources.length > 0) {
        const insertedSources: OnboardingSource[] = insertSources(item.id, sources);
        stampSourcesWithDiscoveryRun(item.id, discoveryRunId);
        const bestSource = sources[0];

        // ── Candidate verification pass ──────────────────────────────
        // Fetch and score the top candidates' page content for
        // product-identity signals BEFORE auto-selection. This prevents
        // confidently saving the wrong URL just because its slug looked
        // tasty on a high-confidence domain.
        updateDiscoveryRunStep(discoveryRunId, 'page_verification');
        const verify = this.deps?.verifyTopCandidates ?? verifyTopCandidates;
        const verificationResults: VerificationResult[] = sources.length > 0
          ? await verify(sources, {
              upc: item.upc,
              // Expected identity is the imported spreadsheet name only —
              // legacy SERP-era expected_name values never steer verification.
              expectedName: item.name,
              brandHint: activeBrandHint,
              price: item.price ? parseFloat(item.price) : null,
              officialDomains,
            })
          : [];
        updateDiscoveryRunStep(discoveryRunId, 'ranking');

        // Log verification outcomes for diagnostics.
        for (const vr of verificationResults) {
          console.log(
            `[OnboardingWorker] Verification for ${item.upc}: ${vr.decisionReason} ` +
            `(url: ${vr.candidate.url})`,
          );
        }

        // ── Auto-selection policy (tightened with P1-A strict identity gate) ──────
        // A candidate may be auto-selected ONLY when the page verifier
        // finds strict strong proof of product identity (proofClass is exact_structured_gtin
        // or exact_variant_gtin with valid GS1 Mod-10 checksum) AND the candidate's domain
        // strictly satisfies the brand authority gate (ADR 0017).
        // The relaxed officialDomainResult bypass is eliminated.
        const isAmbiguous = (s: InsertSourceData) => {
          if (!s.metadataJson) return false;
          try {
            const meta = JSON.parse(s.metadataJson);
            return meta.variantResolution?.status === 'ambiguous';
          } catch {
            return false;
          }
        };

        const verifiedStrong = verificationResults
          .filter(vr => vr.hasStrongProof && !isAmbiguous(vr.candidate));

        // ADR 0017 commitment 2 — authority gate: auto-accept is allowed only
        // when the chosen candidate's domain is a mapped official brand domain
        // (strict isOfficialDomainMatch against the pre-run snapshot). A
        // strongly-verified retailer or off-domain candidate is NEVER
        // auto-accepted as the official source — it falls to manual review so
        // the operator decides authority. Identity evidence from the page
        // verifier (verifiedStrong) remains a separate, additional conjunct.
        const hasAuthority = (s: InsertSourceData): boolean =>
          passesAuthorityGate(activeBrandHint, officialDomains, s.domain);

        // Operational Kill Switch (P1-A):
        // Instant rollback to manual review mode if needed without code regression.
        const isOfficialAutoSelectDisabled =
          process.env.BAYSTATE_CMS_OFFICIAL_AUTO_SELECT_DISABLED === '1' ||
          process.env.BAYSTATE_CMS_OFFICIAL_AUTO_SELECT_DISABLED?.toLowerCase() === 'true';

        const autoSelectedResult = isOfficialAutoSelectDisabled
          ? null
          : verifiedStrong.find((v) => hasAuthority(v.candidate)) ?? null;
        const autoSelectedSource = autoSelectedResult?.candidate ?? null;
        const shouldAutoSelect = autoSelectedSource !== null;

        const killSwitchActive = isOfficialAutoSelectDisabled && verifiedStrong.some(v => hasAuthority(v.candidate));
        const deniedByAuthority =
          !isOfficialAutoSelectDisabled &&
          autoSelectedResult === null &&
          verifiedStrong.length > 0;

        const authorityDetail = deniedByAuthority
          ? ` | authority: auto-accept requires the brand's mapped official domain` +
            ` (brand "${activeBrandHint ?? ''}"` +
            (officialDomains.length > 0
              ? ` official domains: ${officialDomains.join(', ')}`
              : ` has no mapped official domain — assign one in Settings → Domain Configuration`) +
            ')'
          : '';

        const killSwitchDetail = killSwitchActive
          ? ' | kill_switch: official auto-selection disabled by kill switch (BAYSTATE_CMS_OFFICIAL_AUTO_SELECT_DISABLED=1)'
          : '';

        updateDiscoveryRunStep(discoveryRunId, 'applying_outcome');

        if (shouldAutoSelect && autoSelectedSource) {
          const resolvedUrl = autoSelectedSource.url;
          setDiscoverySourceUrl(item.id, resolvedUrl);
          completeDiscoveryRun(
            discoveryRunId,
            'auto_selected',
            `Auto-selected verified source: ${resolvedUrl} (${autoSelectedResult?.decisionReason ?? 'verified'})`,
          );

          // Find the inserted counterpart of the auto-selected source
          // by URL.
          const autoSelectedInserted = insertedSources.find(
            s => s.url === resolvedUrl,
          );
          if (autoSelectedInserted) {
            selectSource(autoSelectedInserted.id);
          }

          console.log(
            `[OnboardingWorker] ✓ Auto-selected verified source for "${item.name}" (${item.upc}): ` +
            `${resolvedUrl} (${autoSelectedResult?.decisionReason})`
          );
        } else {
          // Build a detailed reason that includes verification signals
          // so the reviewer knows WHY auto-selection was skipped.
          const topVerification = verificationResults[0];
          const verificationDetail = topVerification
            ? ` | verification: ${topVerification.decisionReason}`
            : '';
          completeDiscoveryRun(
            discoveryRunId,
            'needs_input_candidates',
            `No candidate passed verification — needs manual URL review${verificationDetail}${authorityDetail}${killSwitchDetail}`,
          );
          const manualReviewReason =
            `needs_review: no candidate passed verification${verificationDetail}${authorityDetail}${killSwitchDetail}`;
          updateItemStageStatus(item.id, 'completed', manualReviewReason);

          console.log(
            `[OnboardingWorker] ⚠ Discovery needs manual review for "${item.name}" (${item.upc}): ` +
            `${manualReviewReason}`
          );
        }

        const topVerificationForEvent = verificationResults[0];
        onboardingEvents.emitItemStatus(item.batchId, item.id, 'completed', {
          stage: 'find_product_page',
          sourceUrl: shouldAutoSelect && autoSelectedSource ? autoSelectedSource.url : null,
          autoSelected: shouldAutoSelect,
          needsManualReview: !shouldAutoSelect,
          manualReviewReason: shouldAutoSelect
            ? null
            : `needs_review: no candidate passed verification` +
              (topVerificationForEvent ? ` | ${topVerificationForEvent.decisionReason}` : '') +
              authorityDetail +
              killSwitchDetail,
          bestCandidateUrl: bestSource.url,
          bestCandidateDomain: bestSource.domain ?? null,
          officialDomains,
          consolidatedName: consolidatedName || null,
          sourcesCount: sources.length,
          topConfidence: bestSource.confidence,
          sitemapMatched,
          sitemapCandidateCount,
          verificationResults: verificationResults.map(vr => ({
            url: vr.candidate.url,
            score: vr.verificationScore,
            proofClass: vr.proofClass,
            hasStrongProof: vr.hasStrongProof,
            decisionReason: vr.decisionReason,
            signals: vr.signals,
          })),
        });
      } else {
        // Audit-trace accuracy: when official domains were configured, the
        // sitemap fetch/match pass DID run — record it before parking the run
        // so the trace doesn't overstate an early 'preflight' exit.
        if (officialDomains.length > 0) {
          updateDiscoveryRunStep(discoveryRunId, 'sitemap_fetch');
        }
        completeDiscoveryRun(discoveryRunId, 'needs_input_no_candidates', 'No matching product pages found');
        updateItemStageStatus(item.id, 'completed', 'No matching product pages found');
        onboardingEvents.emitItemStatus(item.batchId, item.id, 'completed', {
          stage: 'find_product_page',
          warning: 'No sources found',
          needsManualReview: true,
          manualReviewReason: 'No sources found',
          consolidatedName: consolidatedName || null,
          sitemapMatched: false,
          sitemapCandidateCount: 0,
        });
      }
    } catch (err) {
      console.error(`[OnboardingWorker] Discovery error for ${item.id}:`, err);
      if (discoveryRunId) {
        failDiscoveryRun(discoveryRunId, err instanceof Error ? err.message : String(err));
      }
      const retry = incrementRetryCount(item.id);
      if (retry < 2) {
        updateItemStageStatus(item.id, 'pending');
        onboardingEvents.emitItemStatus(item.batchId, item.id, 'pending', {
          stage: 'find_product_page',
          error: String(err),
        });
      } else {
        updateItemStageStatus(item.id, 'failed', String(err));
        onboardingEvents.emitItemStatus(item.batchId, item.id, 'failed', {
          stage: 'find_product_page',
          error: String(err),
        });
      }
    }
  }

  private async processExtraction(item: any): Promise<void> {
    this.extractionRunning++;
    const done = () => { this.extractionRunning = Math.max(0, this.extractionRunning - 1); };
    try {
      // Amendment A (Milestone D): a distributor-record source item has NO
      // official page — the extraction is the deterministic structured
      // materialization of the qualified distributor evidence (no URL, no
      // profile, no fetch/OCR/model calls). Integrity failures are stable
      // codes; the item is NOT blindly retried (unchanged evidence cannot
      // heal an integrity error).
      if (item.sourceType === 'distributor_record') {
        await this.processDistributorRecordExtraction(item);
        return;
      }

      if (!item.sourceUrl) {
        updateItemStageStatus(item.id, 'failed', 'No confirmed source URL');
        onboardingEvents.emitItemStatus(item.batchId, item.id, 'failed', {
          stage: 'collect_details',
          error: 'No confirmed source URL',
        });
        return;
      }

      console.log(`[OnboardingWorker] Extraction for ${item.name} from ${item.sourceUrl}`);

      let domain = '';
      try {
        domain = new URL(item.sourceUrl).hostname.replace(/^www\./, '');
      } catch {
        // Keep the empty domain so the missing-profile failure below remains explicit.
      }
      const profile = domain ? findProfileByDomain(domain) : null;
      if (!profile) {
        const errorMsg = `No extractor profile for ${domain} — profile required`;
        updateItemStageStatus(item.id, 'failed', errorMsg);
        onboardingEvents.emitItemStatus(item.batchId, item.id, 'failed', {
          stage: 'collect_details',
          error: errorMsg,
        });
        return;
      }

      try {
        // ── Variant selection forwarding (M4) ───────────────────────
        let variantSelection: { resolutionId: string; identityMatrixHash: string; variantKey: string } | undefined;
        try {
          if (getEffectiveVariantResolutionMode() !== 'off' && item.sourceType !== 'distributor_record') {
            const db = getDb();
            const repo = createVariantResolutionRepo(db);
            const cur = repo.getCurrentForItem(item.id);
            if (cur && cur.selected_variant_key && cur.identity_matrix_hash) {
              // Verify not superseded/stale (getCurrent ensures current) and status is selected/resolved
              variantSelection = {
                resolutionId: cur.id,
                identityMatrixHash: cur.identity_matrix_hash,
                variantKey: cur.selected_variant_key,
              };
            }
          }
        } catch { /* best effort — no variant forwarding */ }
        const extractedData = await extractProductData(item.sourceUrl, {
          name: item.expectedName || item.name,
          brandHint: item.brandHint,
          price: item.price,
          // ADR-0031: enables real identity classification in ladder enrichment.
          gtin: item.upc || undefined,
          variantSelection,
        } as any);

        if (item.brandHint && !extractedData.brand) extractedData.brand = item.brandHint;
        if (item.price && !extractedData.price) extractedData.price = item.price;

        // variant success persistence (M4) — if extraction carried receipt, ensure resolution row exists
        try {
          const sel: any = (extractedData as any).selectedVariant;
          const selKey = sel?.selectedVariantKey ?? sel?.variantKey;
          if (sel && sel.identityMatrixHash && selKey && getEffectiveVariantResolutionMode() === 'active') {
            const db = getDb();
            const repo = createVariantResolutionRepo(db);
            const cur = repo.getCurrentForItem(item.id);
            if (!cur || cur.identity_matrix_hash !== sel.identityMatrixHash || cur.selected_variant_key !== selKey) {
              const now = new Date().toISOString();
              if (cur) repo.supersedeCurrent(item.id, now);
              repo.create({
                id: sel.resolutionId ?? sel.selectedVariantKey ?? `vr-auto-${item.id}-${Date.now()}`,
                onboarding_item_id: item.id,
                source_url: sel.selectedDeepLink ?? sel.deepLink ?? item.sourceUrl,
                canonical_parent_key: item.sourceUrl,
                platform: (sel as any).platform ?? 'unknown',
                parser_version: sel.parserVersion ?? 1,
                identity_matrix_hash: sel.identityMatrixHash,
                source_content_hash: null,
                status: 'selected',
                reason_codes_json: JSON.stringify(['auto_resolved']),
                candidates_json: JSON.stringify((sel as any).candidates ?? (sel as any).identifiers ?? []),
                automatic_variant_key: selKey,
                selected_variant_key: selKey,
                decision_origin: sel.decisionOrigin ?? 'automatic',
                decided_at: now,
                superseded_at: null,
                created_at: now,
                updated_at: now,
              });
            }
          }
        } catch {
          // best-effort resolution persistence
        }
        insertExtraction({
          itemId: item.id,
          sourceUrl: item.sourceUrl,
          extractionDataJson: JSON.stringify(extractedData),
          extractionMethod: 'worker_crawlee_camoufox',
          confidence: extractedData.confidence,
          imagesJson: null,
          rawStructuredDataJson: JSON.stringify(extractedData.fieldProvenance),
        });

        if (item.sourceUrl) {
          try {
            enrichUrlMetadata(item.sourceUrl, {
              title: extractedData.title,
              brand: extractedData.brand,
              upc: item.upc || null,
              lastFetchedAt: new Date().toISOString(),
            });
          } catch { /* best effort */ }
        }

        const db = getDb();
        db.query('UPDATE onboarding_items SET extraction_data_json = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify(extractedData),
          new Date().toISOString(),
          item.id,
        );

        updateItemStageStatus(item.id, 'completed');
        onboardingEvents.emitItemStatus(item.batchId, item.id, 'completed', {
          stage: 'collect_details',
          extractedData,
        });

        console.log(
          `[OnboardingWorker] ✓ Extraction complete for "${item.name}" (${item.upc}): ` +
          `title="${extractedData.title || 'N/A'}", brand="${extractedData.brand || 'N/A'}", ` +
          `price="${extractedData.price || 'N/A'}", confidence=${(extractedData.confidence * 100).toFixed(0)}%, ` +
          `images=${extractedData.additionalImages ? extractedData.additionalImages.length : 0}`
        );

        // Issue #30 PR2: after extraction completes, refresh the batch's
        // candidate cohorts so family readiness reflects the new evidence.
        // Refresh failure must never fail extraction.
        try {
          await refreshCandidateCohorts(this.workspaceId, item.batchId);
        } catch (err) {
          console.warn(`[OnboardingWorker] Candidate cohort refresh failed for batch ${item.batchId} (non-blocking):`, err);
        }
      } catch (err) {
        // Variant gate fails closed — do not consume retry budget, set needs_input (M4)
        const isVariantGate = err instanceof VariantExtractionError;
        if (isVariantGate) {
          const code = (err as any).failureCode as string;
          // Persist/refresh variant resolution evidence with canonical matrix + real hash so operator can select (P0)
          try {
            if (getEffectiveVariantResolutionMode() === 'active' && item.sourceType !== 'distributor_record') {
              const db = getDb();
              const repo = createVariantResolutionRepo(db);
              const cur = repo.getCurrentForItem(item.id);
              const md: any = (err as any).matrixDecision;
              const matrix: any = (err as any).matrix ?? md?.matrix ?? null;
              const hash: string | null = (err as any).identityMatrixHash ?? md?.identityMatrixHash ?? matrix?.identityMatrixHash ?? null;
              const candidates: any[] = (err as any).candidates ?? md?.candidates ?? matrix?.candidates ?? [];
              const platform: string = matrix?.platform ?? md?.platform ?? 'unknown';
              const parserVersion: number = matrix?.parserVersion ?? md?.parserVersion ?? 1;
              const realHash = hash && /^[a-f0-9]{64}$/.test(hash) ? hash : null;
              // Reject missing evidence instead of fabricating synthetic hashes (f*64/0*64).
              // Require valid 64hex hash and bounded non-empty candidates for durable evidence.
              const boundedCandidates = Array.isArray(candidates) ? candidates.slice(0, 250) : [];
              if (!realHash || boundedCandidates.length === 0) {
                console.warn(`[OnboardingWorker] Variant gate ${code} for ${item.id} missing valid matrix evidence (hash=${hash}, candidates=${boundedCandidates.length}) — not persisting synthetic resolution`);
              } else {
                const shouldCreate = !cur || cur.identity_matrix_hash !== realHash;
                if (shouldCreate) {
                  const now = new Date().toISOString();
                  if (cur) repo.supersedeCurrent(item.id, now);
                  repo.create({
                    id: md?.resolutionId ?? `vr-${item.id}-${Date.now()}`,
                    onboarding_item_id: item.id,
                    source_url: matrix?.sourceFinalUrl ?? item.sourceUrl,
                    canonical_parent_key: matrix?.canonicalParentUrl ?? item.sourceUrl,
                    platform,
                    parser_version: parserVersion,
                    identity_matrix_hash: realHash,
                    source_content_hash: matrix?.sourceContentHash ?? null,
                    status: code === 'variant_selection_required' ? 'ambiguous' : code === 'variant_selection_stale' ? 'stale' : 'unsupported',
                    reason_codes_json: JSON.stringify(md?.reasonCodes ?? [code]),
                    candidates_json: JSON.stringify(boundedCandidates),
                    automatic_variant_key: null,
                    selected_variant_key: null,
                    decision_origin: null,
                    decided_at: null,
                    superseded_at: null,
                    created_at: now,
                    updated_at: now,
                  });
                }
              }
            }
          } catch {
            // best-effort resolution persistence
          }
          console.warn(`[OnboardingWorker] Variant gate ${code} for ${item.id} — parking as needs_input`);
          updateItemStageStatus(item.id, 'needs_input', `variant:${code}:${String(err)}`);
          onboardingEvents.emitItemStatus(item.batchId, item.id, 'needs_input', {
            stage: 'collect_details',
            error: `variant:${code}`,
            variantFailureCode: code,
          });
          return;
        }
        console.error(`[OnboardingWorker] Extraction error for ${item.id}:`, err);
        const retry = incrementRetryCount(item.id);
        if (retry < 2) {
          updateItemStageStatus(item.id, 'pending');
          onboardingEvents.emitItemStatus(item.batchId, item.id, 'pending', {
            stage: 'collect_details',
            error: String(err),
          });
        } else {
          updateItemStageStatus(item.id, 'failed', String(err));
          onboardingEvents.emitItemStatus(item.batchId, item.id, 'failed', {
            stage: 'collect_details',
            error: String(err),
          });
        }
      }
    } finally {
      done();
    }
  }

  /**
   * Deterministic distributor-record extraction (Amendment A Milestone D;
   * Amendment B merchandising depth).
   *
   * Branched BEFORE the URL/profile checks in `processExtraction`: a
   * `distributor_record` source item has no official page to scrape. The
   * materializer rechecks every authority inside one transaction and writes
   * the extraction atomically (row + item payload + completed status) — v1
   * identity-only or v2 merchandising-depth per the decision/projection
   * version. Integrity failures surface a stable error code and leave the
   * item `extraction/failed` — never retried as an official-page extraction
   * and never blindly retried (unchanged evidence cannot heal them).
   */
  private async processDistributorRecordExtraction(item: any): Promise<void> {
    // Ticket #122: `completed_strategy_collection` decisions dispatch by
    // validated envelope BEFORE the legacy materializer: compatible
    // contributions consolidate, and the completed-empty branch preserves
    // safe imported evidence with explicit provenance. Legacy
    // distributor_record_to_extraction decisions keep the legacy path
    // (including qualified strategy collections, which carry both).
    if ((item.sourcingDecision as { route?: string } | null)?.route === 'completed_strategy_collection') {
      let result: import('./sourcing/distributor-record-materializer').StrategyCollectionMaterializationResult;
      try {
        result = materializeStrategyCollectionExtraction(item.id, this.workspaceId);
      } catch (err) {
        console.error(
          `[OnboardingWorker] Strategy-collection extraction threw for ${item.id} (mapped to internal_error):`,
          err,
        );
        const errorMsg = 'strategy_collection_materialization:internal_error';
        updateItemStageStatus(item.id, 'failed', errorMsg);
        onboardingEvents.emitItemStatus(item.batchId, item.id, 'failed', {
          stage: 'collect_details',
          error: errorMsg,
        });
        return;
      }
      if (result.ok) {
        onboardingEvents.emitItemStatus(item.batchId, item.id, 'completed', {
          stage: 'collect_details',
          extractedData: result.extractionData,
        });
        console.log(
          `[OnboardingWorker] ✓ Strategy-collection extraction complete for "${item.name}" (${item.upc}): ` +
            `title="${String((result.extractionData as Record<string, unknown>).title ?? 'N/A')}", ` +
            `strategy collection (no official page)${result.idempotent ? ' [idempotent retry]' : ''}`,
        );
        try {
          await refreshCandidateCohorts(this.workspaceId, item.batchId);
        } catch (err) {
          console.warn(`[OnboardingWorker] Candidate cohort refresh failed for batch ${item.batchId} (non-blocking):`, err);
        }
        return;
      }
      const errorMsg = `strategy_collection_materialization:${result.code}`;
      console.error(`[OnboardingWorker] Strategy-collection extraction integrity failure for ${item.id}: ${result.code}`);
      updateItemStageStatus(item.id, 'failed', errorMsg);
      onboardingEvents.emitItemStatus(item.batchId, item.id, 'failed', {
        stage: 'collect_details',
        error: errorMsg,
      });
      return;
    }
    // Defense in depth (Milestone D round-8): the materializer must never
    // throw on malformed authority data — every parse is guarded and failures
    // return stable codes. If it still throws unexpectedly, map to a stable
    // internal_error code so the item ALWAYS reaches extraction/failed
    // instead of staying in_progress in the log-only generic catch.
    let result: DistributorMaterializationResult;
    try {
      result = materializeDistributorRecordExtraction(item.id, this.workspaceId);
    } catch (err) {
      console.error(
        `[OnboardingWorker] Distributor-record extraction threw for ${item.id} (mapped to internal_error):`,
        err,
      );
      const errorMsg = `distributor_materialization:${DISTRIBUTOR_MATERIALIZATION_ERROR_CODES.internal_error}`;
      updateItemStageStatus(item.id, 'failed', errorMsg);
      onboardingEvents.emitItemStatus(item.batchId, item.id, 'failed', {
        stage: 'collect_details',
        error: errorMsg,
      });
      return;
    }
    if (result.ok) {
      onboardingEvents.emitItemStatus(item.batchId, item.id, 'completed', {
        stage: 'collect_details',
        extractedData: result.extractionData,
      });
      console.log(
        `[OnboardingWorker] ✓ Distributor-record extraction complete for "${item.name}" (${item.upc}): ` +
          `title="${String(result.extractionData.title ?? 'N/A')}", ` +
          `brand="${String(result.extractionData.brand ?? 'N/A')}", ` +
          `distributor record (no official page)${result.idempotent ? ' [idempotent retry]' : ''}`,
      );

      // Issue #30 PR2: refresh candidate cohorts so family readiness reflects
      // the new evidence. Refresh failure must never fail extraction.
      try {
        await refreshCandidateCohorts(this.workspaceId, item.batchId);
      } catch (err) {
        console.warn(`[OnboardingWorker] Candidate cohort refresh failed for batch ${item.batchId} (non-blocking):`, err);
      }
      return;
    }

    // Deterministic integrity failure: stable code, extraction/failed, no
    // partial writes (the materializer transaction performed none).
    const errorMsg = `distributor_materialization:${result.code}`;
    console.error(`[OnboardingWorker] Distributor-record extraction integrity failure for ${item.id}: ${result.code}`);
    updateItemStageStatus(item.id, 'failed', errorMsg);
    onboardingEvents.emitItemStatus(item.batchId, item.id, 'failed', {
      stage: 'collect_details',
      error: errorMsg,
    });
  }

  private async processCuration(item: any): Promise<void> {
    console.log(`[OnboardingWorker] Curation for ${item.name} (${item.upc})`);

    const now = new Date().toISOString();

    // ── Sibling context for family-aware curation ────────────────────────
    // Before running the pipeline, determine product-line groups so the
    // name_consolidation and page-assignment stages receive sibling INPUT
    // context (names, web titles, OCR titles, SKUs) as read-only hints.
    // listItemsByBatch returns full OnboardingItem objects (camelCase).
    let siblingGroup: ReturnType<typeof determineProductGroup> | null = null;
    try {
      const batchItems = listItemsByBatch(item.batchId);
      siblingGroup = determineProductGroup(item as OnboardingItem, batchItems);
      if (siblingGroup) {
        console.log(`[OnboardingWorker] Sibling context for ${item.upc}: group "${siblingGroup.groupId}", ${siblingGroup.siblingNames.length} sibling(s)`);
      }
    } catch (err: any) {
      console.warn(`[OnboardingWorker] Sibling context discovery failed (non-blocking): ${err.message}`);
    }

    // Pass sibling context through to the pipeline as read-only input.
    // product-curator.ts checks this first and falls back to its own internal query.
    (item as OnboardingItem & { siblingGroup?: typeof siblingGroup }).siblingGroup = siblingGroup;

    // Ticket #122: strategy-collection authority gate. A distributor item
    // whose current generation holds a finalized envelope curates ONLY
    // under that frozen authority (never reconstructed from live config);
    // a present-but-invalid envelope fails closed. Generations without an
    // envelope keep the legacy interpretation (compat fallback).
    let strategyEnvelope: { envelope: StrategyCollectionResult; hash: string } | null = null;
    if (item.sourceType === 'distributor_record') {
      try {
        const curationGeneration = getCurrentSourcingGeneration(item.id);
        strategyEnvelope = curationGeneration ? getStrategyCollectionResult(curationGeneration.id) : null;
      } catch (err) {
        const code = err instanceof Error ? (err as Error & { code?: string }).code ?? 'invalid_envelope' : 'invalid_envelope';
        if (code !== 'missing_envelope') {
          const errorMsg = `strategy_collection:${code}`;
          console.error(`[OnboardingWorker] Strategy-collection authority failure for ${item.id}: ${code}`);
          updateItemStageStatus(item.id, 'failed', errorMsg);
          onboardingEvents.emitItemStatus(item.batchId, item.id, 'failed', {
            stage: 'prepare_listing',
            error: errorMsg,
          });
          return;
        }
      }
    }

    // Ticket #124: load an open gap's recorded correction overlay (if any)
    // BEFORE curating. The envelope row is immutable; a concurrent new
    // correction supersedes this run's overlay (stale → run proceeds
    // without it, gap stays open — never a mixed-revision blend).
    let correctionOverlay: import('./product-curator').GapCorrectionOverlay | null = null;
    let correctionRevision = 0;
    let correctionHash: string | null = null;
    let correctionActor: string | null = null;
    let correctionBaseEvidenceHash: string | null = null;
    try {
      const openGap = getPreparationGap(item.id);
      const envelope = openGap?.status === 'open' ? openGap.correctionEnvelope : null;
      if (envelope && (envelope.status === 'recorded' || envelope.status === 'preparing')) {
        try {
          markCorrectionRun({ itemId: item.id, revision: envelope.revision, runId: null, status: 'preparing' });
          correctionOverlay = {
            values: envelope.values,
            correctionHash: envelope.correctionHash,
            actor: envelope.actor,
            revision: envelope.revision,
          };
          correctionRevision = envelope.revision;
          correctionHash = envelope.correctionHash;
          correctionActor = envelope.actor;
          correctionBaseEvidenceHash = envelope.baseEvidenceHash ?? null;
        } catch {
          correctionOverlay = null;
        }
      }
    } catch {
      correctionOverlay = null;
    }

    try {
      const curationData = await curateItemWithPipeline(item, this.workspacePath, this.workspaceId, correctionOverlay);

      const db = getDb();
      db.query('UPDATE onboarding_items SET curation_data_json = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(curationData),
        now,
        item.id,
      );

      // Tickets #122/#124: post-consolidation sufficiency for strategy
      // items (and any item carrying a recorded correction). Required
      // fields come from EXISTING blocking validation requirements —
      // never a hardcoded checklist. Consolidated output (curated first,
      // extraction fallback) is assessed; remaining gaps persist durably
      // (approval/review/promotion refuse while open); a fully sufficient
      // result resolves the gap only through validation-gated resolve.
      if (strategyEnvelope || correctionOverlay || correctionRevision > 0 || hasUnresolvedPreparationGap(item.id)) {
        let extractionDescription: string | null = null;
        try {
          const extractionPayload = item.extraction_data_json
            ? (JSON.parse(item.extraction_data_json) as { description?: unknown })
            : null;
          extractionDescription = typeof extractionPayload?.description === 'string'
            ? extractionPayload.description
            : null;
        } catch { extractionDescription = null; }
        const curated = curationData as { curatedTitle?: unknown; curatedDescription?: unknown };
        const consolidatedDescription = typeof curated.curatedDescription === 'string' && curated.curatedDescription.trim()
          ? curated.curatedDescription
          : extractionDescription;
        // Ticket #124 P2-11: store-configured validation severities
        // (health-config.json rules, same seam as change-set validation)
        // participate in gap derivation — a store that configures
        // MISSING_DESCRIPTION:blocker gets description gaps from the
        // worker. Absent/unreadable config → framework defaults.
        const { missing } = assessListingEvidenceGap({
          consolidatedFields: {
            title: curated.curatedTitle as string | null | undefined,
            description: consolidatedDescription,
          },
          requiredFields: blockingPreparationFields(loadPreparationRulesConfig(this.workspacePath)),
        });
        if (missing.length > 0) {
          // Ticket #124 T-7: the refreshed reason names the still-missing
          // fields (bounded to 160 chars by safeReason) so a failed
          // correction stays actionable instead of merely "open".
          const refreshed = openPreparationGap({
            workspaceId: this.workspaceId,
            itemId: item.id,
            batchId: item.batchId,
            collectionResultVersion: 'strategy-collection-v1',
            missingFields: missing,
            reason: `Preparation is still missing required listing information: ${missing.join(', ')}.`,
            evidenceHash: strategyEnvelope?.hash ?? getPreparationGap(item.id)?.evidenceHash ?? null,
          });
          void refreshed;
          if (correctionOverlay && correctionHash) {
            try {
              markCorrectionRun({ itemId: item.id, revision: correctionRevision, runId: null, status: 'failed' });
            } catch {
              // Audit transition is best-effort; the open gap is authoritative.
            }
          }
        } else if (correctionOverlay && correctionHash && correctionActor) {
          // Ticket #124 P1-1/P1-5: the resolve binds the VALIDATION-time
          // collection hash (never the just-read gap row, which would be
          // tautological), and a stale_gap (concurrent newer correction or
          // re-finalized collection) returns the item to pending for
          // reclaim instead of stranding it in failed.
          try {
            resolveAfterValidation({
              itemId: item.id,
              revision: correctionRevision,
              correctionHash,
              evidenceHash: strategyEnvelope?.hash ?? correctionBaseEvidenceHash ?? null,
              resolvedBy: correctionActor,
            });
          } catch (err) {
            if (err instanceof Error && (err as Error & { code?: string }).code === 'stale_gap') {
              const staleMsg = 'gap correction superseded during preparation; awaiting re-preparation';
              console.warn(`[OnboardingWorker] Stale gap resolve for ${item.id} (rev ${correctionRevision}); returning to pending.`);
              updateItemStageStatus(item.id, 'pending', staleMsg);
              onboardingEvents.emitItemStatus(item.batchId, item.id, 'pending', {
                stage: 'prepare_listing',
                error: staleMsg,
              });
              return;
            }
            throw err;
          }
        } else {
          // Sufficient on retained evidence alone (e.g. explicit
          // recollection fixed it): clear an open gap without correction.
          const liveGap = getPreparationGap(item.id);
          if (liveGap?.status === 'open') {
            try {
              resolveAfterValidation({
                itemId: item.id,
                revision: 0,
                correctionHash: '',
                evidenceHash: strategyEnvelope?.hash ?? liveGap.evidenceHash ?? null,
                resolvedBy: 'preparation-validation',
              });
            } catch (err) {
              if (err instanceof Error && (err as Error & { code?: string }).code === 'stale_gap') {
                const staleMsg = 'gap changed during preparation; awaiting re-preparation';
                console.warn(`[OnboardingWorker] Stale revision-0 gap resolve for ${item.id}; returning to pending.`);
                updateItemStageStatus(item.id, 'pending', staleMsg);
                onboardingEvents.emitItemStatus(item.batchId, item.id, 'pending', {
                  stage: 'prepare_listing',
                  error: staleMsg,
                });
                return;
              }
              throw err;
            }
          }
        }
      }

      updateItemStageStatus(item.id, 'completed');

      // PR9 C3 (issue #30, DECISION-C): in ACTIVE cohort mode an item whose
      // active run is a cohort child surfaces the NEW validator's findings
      // instead of the legacy `validateSiblingConsistency` warnings
      // (legacy/shadow keep the legacy warnings byte-identical — the
      // defensive branch below is unreachable in practice because active mode
      // curates cohorts exclusively). PR9 review R1 (B6): the discriminated
      // surface never falls back to legacy live-regrouping in active mode.
      const semanticSurface = activeCohortSemanticFindingsForItem(item);
      // Run cross-sibling consistency check and include warnings in SSE event
      let consistencyWarnings: Array<{ field: string; message: string }> = [];
      try {
        if (semanticSurface.mode === 'active') {
          consistencyWarnings = semanticSurface.semanticValidation.findings.map(finding => ({
            field: finding.code,
            message: finding.message,
          }));
        } else {
          const allWarnings = validateSiblingConsistency(item.batchId);
          consistencyWarnings = allWarnings
            .filter(w => {
              // w.values is Record<sku, string[]> — check if this item's SKU is a key
              return Object.prototype.hasOwnProperty.call(w.values, item.upc);
            })
            .map(w => ({ field: w.field, message: w.message }));
          if (consistencyWarnings.length > 0) {
            console.warn(`[OnboardingWorker] Consistency warnings for ${item.upc}:`, JSON.stringify(consistencyWarnings));
          }
        }
      } catch (err: any) {
        console.warn(`[OnboardingWorker] Consistency check failed (non-blocking): ${err.message}`);
      }

      onboardingEvents.emitItemStatus(item.batchId, item.id, 'completed', {
        stage: 'prepare_listing',
        curationData,
        consistencyWarnings: consistencyWarnings.length > 0 ? consistencyWarnings : undefined,
        semanticValidation: semanticSurface.mode === 'active' ? semanticSurface.semanticValidation : undefined,
      });

      console.log(
        `[OnboardingWorker] ✓ Curation complete for "${item.name}" (${item.upc}): ` +
        `curatedTitle="${curationData.curatedTitle || 'N/A'}", ` +
        `titleSource=${curationData.titleSource}, ` +
        `suggestedPages=[${(curationData.suggestedPages || []).join(', ') || 'none'}], ` +
        `productType=${curationData.suggestedProductType || 'N/A'}`
      );
    } catch (err) {
      console.error(`[OnboardingWorker] Curation error for ${item.id}:`, err);
      updateItemStageStatus(item.id, 'failed', String(err));
      onboardingEvents.emitItemStatus(item.batchId, item.id, 'failed', {
        stage: 'prepare_listing',
        error: String(err),
      });
    }
  }
}
