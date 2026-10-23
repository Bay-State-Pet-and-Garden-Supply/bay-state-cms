import {
  claimItemsForProcessing,
  requeueStaleInProgressItems,
  updateItemStageStatus,
  incrementRetryCount,
  setDiscoverySourceUrl,
  findItemById,
  storedStageIs,
  commitClaimedItemCuration,
  failClaimedItemCuration,
  releaseClaimedItemCuration,
  type ClaimedItemCurationLease,
  type ClaimedItemExtractionLease,
  commitClaimedItemExtraction,
  requireClaimedItemExtractionInput,
  releaseClaimedItemExtraction,
  failClaimedItemExtraction,
  type OnboardingItemWithEntryPolicy,
} from '../db/repositories/onboarding-item-repo';
import { findBatchById } from '../db/repositories/onboarding-batch-repo';
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
  listSourcesByItem,
  type InsertSourceData,
} from '../db/repositories/onboarding-source-repo';
import { verifyTopCandidates, type VerificationResult } from './page-verifier';
import { findBrandSites } from '../db/repositories/brand-site-repo';
import { extractProductData, extractConfirmedPageStatic, VariantExtractionError } from './page-extractor';
import { validateExtraction } from './extraction-validator';
import { listOfficialPageDecisions, recordOfficialPageDecision } from '../db/repositories/official-page-decision-repo';
import { createVariantResolutionRepo } from '../db/repositories/onboarding-variant-resolution-repo';
import { getEffectiveVariantResolutionMode } from './variant-flags';
import { assertSafeVariantDestination } from '../shared/ssrf';

import { findContradictoryProductAxes, matchOfficialPageIdentity } from './official-page-identity';
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
import { resolveExecutableProfile } from './domain-version-health';
import { curateItemWithPipeline, type GapCorrectionOverlay } from './product-curator';
import { refreshCandidateCohorts } from './curation-cohort-service';


import {
  getCurrentCohortRun,
  supersedeCohortRun,
} from '../db/repositories/classification-cohort-run-repo';
import { listCohortsByWorkspace } from '../db/repositories/curation-cohort-repo';
import { insertExtraction } from '../db/repositories/onboarding-extraction-repo';
import { onboardingEvents } from './sse-emitter';
import { getDb } from '../db/connection';
import { readStoreConfig } from '../git/workspace-files';
import type { OnboardingSource, PipelineStage } from '../shared/schemas/onboarding';
import type { AcceptedItemEvidence } from '../shared/schemas/item-evidence';
import { refreshItemEvidence, getCurrentItemEvidenceView } from './item-evidence';
import { withItemAcquisitionBudget } from './item-acquisition-budget';
import { createItemAcquisitionRun, finishItemAcquisitionRun } from './item-acquisition-run';
import { getAllowedOfficialPageDomains, isAuthorizedOfficialPageUrl } from './official-page-authority';
import { getSourcingFlags } from './flags';
import { runItemEvidenceAcquisition } from './item-evidence-acquisition';
import { redactTransportText } from '../classification/model-policy-gateway';
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
  resolveAfterValidation,
  hasUnresolvedPreparationGap,
  blockingPreparationFields,
  markCorrectionRun,
} from '../db/repositories/preparation-gap-repo';
import type { StrategyCollectionResult } from './sourcing/strategy-collection-result';
import { usableContributions } from './sourcing/strategy-collection-result';
import type { SourcingDecision, SourcingDecisionV2 } from '../shared/schemas/onboarding';
import { sweepAutoAdvance } from './auto-advance';
import { sweepDomainReleases } from './domain-release';

class ItemCurationLeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ItemCurationLeaseLostError';
  }
}
/**
 * Automatic per-item processing stages (ADR 0014 Amendment A). Sourcing
 * joins the list ONLY for valid manual/automatic rollout modes with the
 * capability effective-enabled; observe mode never claims Sourcing (imports
 * enter Discovery and are shadow-observed from there), and OFF/invalid modes
  // Manual and automatic stages share the item-local claim path.
 */
function buildAutoStages(): PipelineStage[] {
  const flags = getSourcingFlags();
  const includeSourcing =
    flags.effectiveEnabled && (flags.mode === 'manual' || flags.mode === 'automatic');
  return includeSourcing
    ? ['route_sources', 'prepare_listing', 'collect_details', 'find_product_page']
    : ['prepare_listing', 'collect_details', 'find_product_page'];
}


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
/** Issue #303: one cooperative yield to the event loop via `setImmediate`
 * (macrotask — socket IO progresses; microtask-only awaits would starve
 * HTTP exactly the way the wedged iteration did). Passed into the pre-claim
 * sweeps so a large batch yields between every unit of work. */
function yieldToEventLoop(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
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
function acceptedEvidenceExtractionProjection(evidence: AcceptedItemEvidence, sourceUrl: string): Record<string, unknown> {
  const byField = new Map<string, AcceptedItemEvidence['facts'][number]>();
  for (const entry of evidence.facts) if (!byField.has(entry.field.toLowerCase())) byField.set(entry.field.toLowerCase(), entry);
  const title = byField.get('title');
  const brand = byField.get('brand');
  const gtinIdentity = evidence.observations.find(observation => observation.identity.proofType === 'gtin')?.identity ?? null;
  const fieldProvenance = Object.fromEntries(evidence.facts.map(entry => [entry.field, `accepted-item-fact:${entry.id}`]));
  const variantAttributes = Object.fromEntries(
    evidence.facts
      .filter(entry => ['size', 'count', 'packcount', 'flavor', 'formula'].includes(entry.field.toLowerCase()))
      .map(entry => [entry.field, entry.value]),
  );
  return {
    title: title?.value ?? null,
    brand: brand?.value ?? null,
    description: null,
    bulletPoints: [],
    primaryImage: null,
    additionalImages: [],
    price: evidence.importedPrice,
    weight: byField.get('weight')?.value ?? null,
    dimensions: byField.get('dimensions')?.value ?? null,
    searchKeywords: null,
    sourceType: 'official_page',
    sourceUrl,
    fieldProvenance,
    acceptedEvidenceProvenance: {
      snapshotId: evidence.id,
      revision: evidence.revision,
      evidenceHash: evidence.evidenceHash,
      inputHash: evidence.inputHash,
      factIds: evidence.facts.map(entry => entry.id),
      gtinIdentityProof: gtinIdentity ? { proofType: gtinIdentity.proofType, proofHash: gtinIdentity.proofHash } : null,
    },
    variantAttributes,
  };
}

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
  /** Issue #303: consecutive poll failures for exponential backoff; reset on a clean pass. */
  private consecutivePollFailures = 0;
  /** Issue #303: last completed poll duration (ms); null until the first pass completes. */
  private lastPollDurationMs: number | null = null;
  /** Reviewer P1: set by stop(), cleared by start() — in-flight polls no-op. */
  private stopped = false;
  private workspacePath: string;
  private workspaceId: string;
  private workerId: string;
  /** Test seam: inject the sourcing engine factory (defaults to the real engine). */
  private engineFactory: (() => SourcingEngine) | null;
  /** Discovery/verification overrides (test/embedding seam, default null → real impls). */
  private deps: {
    discoverSources?: typeof discoverSources;
    verifyTopCandidates?: typeof verifyTopCandidates;
    extractProductData?: typeof extractProductData;
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
      /** Test/embedding seam: page extraction override (default: real). */
      extractProductData?: typeof extractProductData;
    },
  ) {
    this.workspaceId = workspaceId;
    this.workspacePath = workspacePath;
    this.maxConcurrency = maxConcurrency;
    this.maxExtractionConcurrency = maxExtractionConcurrency;
    this.workerId = randomUUID();
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

    // Cohort-owned in-flight plans from the previous orchestration are
    // incompatible with item-local execution. Supersede them without
    // rewriting their immutable history or reusing their outputs.
    try {
      for (const cohort of listCohortsByWorkspace(this.workspaceId)) {
        const run = getCurrentCohortRun(cohort.id);
        if (run && (run.status === 'freezing' || run.status === 'running')) {
          supersedeCohortRun(run.id, 'Superseded by item-local onboarding execution');
        }
      }
    } catch (err) {
      console.error('[OnboardingWorker] Failed to supersede in-flight cohort runs at item-local cutover:', err);
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
    // Issue #303: wall-clock the whole iteration. The duration log doubles
    // as the starvation detector the 23h wedge lacked.
    const pollStartedAt = Date.now();
    let pollFailed = false;

    try {
      // Epic #46 Phase 2 (automation-owned progression): automatic
      // continuation sweeps run on every poll so happy-path progression needs
      // ZERO manual advance clicks:
      //   1. Discovery-completed with a confirmed URL → Extraction;
      //      Extraction-completed with data → Curation;
      //      Curation-completed with its own current output → Review.
      //   2. Blocked Extraction items whose domain NOW has a usable extractor
      //      profile → re-queued (domain-level release; no per-SKU clicks).
      // Both are deterministic, idempotent, and fail closed into an
      // actionable state; a sweep failure never breaks the poll loop.
      try {
        const autoAdvance = await sweepAutoAdvance(this.workspaceId, { yieldBetweenItems: yieldToEventLoop });
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
        await yieldToEventLoop();
      } catch (err) {
        console.error('[OnboardingWorker] Auto-advance sweep failed (non-blocking):', err);
      }
      try {
        const domainRelease = await sweepDomainReleases(this.workspaceId, { yieldBetweenItems: yieldToEventLoop });
        if (domainRelease.releasedIds.length > 0 || domainRelease.eligibleRemaining > 0) {
          console.log(
            `[OnboardingWorker] Released ${domainRelease.releasedIds.length} extraction item(s) on domains with usable profiles: ` +
            `${domainRelease.domains.join(', ')}` +
            (domainRelease.eligibleRemaining > 0 ? ` (${domainRelease.eligibleRemaining} eligible remaining for later polls)` : ''),
          );
        }
        await yieldToEventLoop();
      } catch (err) {
        console.error('[OnboardingWorker] Domain-release sweep failed (non-blocking):', err);
      }


      // Process stages in priority order: discovery first, then extraction, then curation
      for (const stage of buildAutoStages()) {
        if (this.running.size >= this.maxConcurrency) break;

        // Extraction has a separate concurrency limit to avoid bot detection
        if (stage === 'collect_details' && this.extractionRunning >= this.maxExtractionConcurrency) continue;


        const available = this.maxConcurrency - this.running.size;
        const claimedItems = claimItemsForProcessing(stage, available, this.workspaceId, this.workerId);
        for (const item of claimedItems) {
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


          const promise = this.processItem(item, stage);
          this.running.set(item.id, promise);
          promise.finally(() => this.running.delete(item.id));

          if (this.running.size >= this.maxConcurrency) break;
        }
      }

    } catch (err) {
      pollFailed = true;
      console.error('[OnboardingWorker] Error in poll loop:', err);
    } finally {
      this.isProcessing = false;
      // Issue #303: failure accounting + iteration-duration log. A clean
      // pass resets the backoff; a failed pass counts toward it.
      const pollDurationMs = Date.now() - pollStartedAt;
      this.lastPollDurationMs = pollDurationMs;
      if (pollFailed) {
        this.consecutivePollFailures += 1;
      } else {
        this.consecutivePollFailures = 0;
      }
      if (pollDurationMs > 1000 || pollFailed) {
        console.warn(
          `[OnboardingWorker] Poll iteration ${pollFailed ? 'failed' : 'slow'}: ${pollDurationMs}ms ` +
          `(consecutiveFailures=${this.consecutivePollFailures})`,
        );
      }
    }
  }

  /**
   * Issue #303: observable poll health for tests and operators. The duration
   * of the last completed iteration (ms), or null before the first pass.
   */
  lastPollDuration(): number | null {
    return this.lastPollDurationMs;
  }

  /**
   * Issue #303: consecutive failed poll iterations.
   */
  failedPollCount(): number {
    return this.consecutivePollFailures;
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
      // Ticket #125: revalidate generation + brand ownership before worker
      // routing commits. A pin captured for another brand (reassigned
      // since) never executes — old pins stay history until an explicit
      // new-generation retry captures the current approval.
      try {
        const routingBinding = getGenerationStrategyBinding(generation.id);
        if (isRetiredStrategyBinding(routingBinding)) {
          setupAttentionHold(['This generation used retired brand routing settings. Retry to start a new generation under query-all routing.']);
          return;
        }
        if (routingBinding?.mode === 'approved') {
          const currentBrand = (item.brandHint ?? '').trim().toLowerCase();
          if (routingBinding.strategyBrand !== currentBrand) {
            setupAttentionHold(['Strategy binding brand does not match the item brand; retry in a new generation']);
            return;
          }
        }
      } catch {
        setupAttentionHold(['Strategy binding is invalid for this generation; retry in a new generation']);
        return;
      }

      // Ticket #125 (activation blocker): terminal generations never
      // re-enter collection. A pending item whose generation already
      // completed/failed waits for an explicit new-generation retry —
      // re-dispatch would replay a frozen boundary.
      if (generation.status === 'completed' || generation.status === 'failed') {
        console.log(`[OnboardingWorker] Sourcing generation ${generation.id} already terminal for ${item.id} — no replay without explicit retry`);
        return;
      }

      // Deterministic re-run: reuse existing current-generation attempts.
      if (getCurrentGenerationAttempts(item.id).length === 0) {
        if (normalizeGtin(item.upc) === null) {
          // No usable identifier -> audited pass-through (never a brand-only
          // lookup). Checked BEFORE connections so the warning is truthful.
          // Ticket #125 (activation blocker): zero-identifier items inside
          // an approved boundary park visibly within it — they never leak
          // to the unapproved fallback_to_discovery path.
          let approvedHold = false;
          try {
            const noIdBinding = getGenerationStrategyBinding(generation.id);
            approvedHold = noIdBinding?.mode === 'approved';
          } catch {
            approvedHold = false;
          }
          if (!approvedHold) {
            try {
              approvedHold = getApprovedBrandStrategy(this.workspaceId, item.brandHint ?? null) !== null;
            } catch {
              approvedHold = false;
            }
          }
          if (approvedHold) {
            setupAttentionHold(['Item has no UPC/GTIN for distributor lookup']);
            return;
          }
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
      // Ticket #149: re-entrant strategy-boundary guard. A generation
      // whose pin predates (or misses) the live approval must not fall
      // through to official discovery when the LIVE approved boundary is
      // distributor-only. Zero accepted evidence under a live
      // distributor-only approval parks visibly on that boundary — never
      // the legacy fallback. Scoped to non-approved pins so correctly
      // pinned approved generations keep their envelope contract below.
      // Source-error-mixed cases hold here too (no official discovery is
      // permitted inside the boundary); degraded_fallback_to_discovery
      // below stays reachable only for unapproved generations.
      let liveDistributorOnlyRevision: number | null = null;
      try {
        const liveApproval = getApprovedBrandStrategy(this.workspaceId, item.brandHint ?? null);
        const liveSources = liveApproval?.sources ?? [];
        if (
          liveApproval &&
          liveSources.length > 0 &&
          liveSources.every((s) => s.kind === 'distributor_record') &&
          attempts.length > 0 &&
          reconcile.acceptedAttemptIds.length === 0
        ) {
          let pinApproved = false;
          try {
            pinApproved = getGenerationStrategyBinding(generation.id)?.mode === 'approved';
          } catch {
            pinApproved = false;
          }
          if (!pinApproved) {
            liveDistributorOnlyRevision = liveApproval.revision;
          }
        }
      } catch {
        liveDistributorOnlyRevision = null;
      }
      if (liveDistributorOnlyRevision !== null) {
        setupAttentionHold([
          `Approved strategy revision ${liveDistributorOnlyRevision} has no stocked distributors; retry in a new generation`,
        ]);
        return;
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
      const domains = getAllowedOfficialPageDomains({ workspaceId: this.workspaceId, itemId: item.id, brandHint: item.brandHint ?? null });
      const discover = this.deps?.discoverSources ?? discoverSources;
      const variantNetworkFetch = createVariantDiscoveryFetch(domains);
      const discoveryFetch = createDiscoveryFetch(domains);
      const discovery = await discover(item.upc, item.name, item.brandHint, {
        modelPolicy: policySnapshot.state === 'configured' ? policySnapshot.view : null,
        networkFetch: discoveryFetch,
        variantNetworkFetch,
        frozenDomains: domains,
      });
      const sources = discovery.candidates;
      const consolidatedName = discovery.consolidatedName;

      // Brands and their official domains are operator-configured inputs
      // (brand_sites); discovery never infers or persists a brand mapping.
      const activeBrandHint = item.brandHint;

      // ── Authority snapshot ──────────────────────────────────────────────
      // The official-domain set that may authorize auto-accept THIS run,
      // paired against the item's configured brand hint.
      const officialDomains = domains;

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
                price: null,
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
              // (ADR 0043: no input price — matching uses identity only.)
              expectedName: item.name,
              brandHint: activeBrandHint,
              officialDomains,
            }, sources.length)
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

        // ADR 0040 name-first path: conservative unique name/variant matches confirm
        // without GTIN when coverage is complete, authority holds, the page is a
        // product detail page, and no axis contradicts. GTIN corroborates or
        // contradicts; absence is ordinary.
        const verifiedName = verificationResults
          .filter(vr => !vr.hasStrongProof && !isAmbiguous(vr.candidate) &&
            passesAuthorityGate(activeBrandHint, officialDomains, vr.candidate.domain) &&
            vr.observedIdentity.coverageComplete &&
            vr.observedIdentity.pageKind === 'product' &&
            matchOfficialPageIdentity({
              registerName: item.name,
              registerUpc: item.upc,
              brandHint: activeBrandHint,
              pageName: vr.observedIdentity.pageName ?? '',
              pageBrand: vr.observedIdentity.pageBrand,
              pageKind: vr.observedIdentity.pageKind,
              variants: vr.observedIdentity.variants,
              observedGtins: vr.observedIdentity.observedGtins,
            }).outcome === 'unique_name_variant_match' &&
            findContradictoryProductAxes(item.name, [
              { field: 'heading', value: vr.observedIdentity.pageName ?? '' },
              ...vr.observedIdentity.variants.map((variant) => ({ field: 'variant', value: variant.label })),
            ]).length === 0);

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

        // Accept a candidate confirmed by EITHER GTIN-strong proof OR a unique
        // conservative name/variant match. verifiedName entries already passed
        // authority, coverage, product-kind, matcher, and contradiction gates.
        const verifiedNameSelected = verifiedName.length === 1 ? verifiedName[0] ?? null : null;
        const autoSelectedResult = isOfficialAutoSelectDisabled
          ? null
          : verifiedNameSelected ?? verifiedStrong.find((v) => hasAuthority(v.candidate) && v.observedIdentity.coverageComplete &&
            matchOfficialPageIdentity({
              registerName: item.name,
              registerUpc: item.upc,
              brandHint: activeBrandHint,
              pageName: v.observedIdentity.pageName ?? '',
              pageBrand: v.observedIdentity.pageBrand,
              pageKind: v.observedIdentity.pageKind,
              variants: v.observedIdentity.variants,
              observedGtins: v.observedIdentity.observedGtins,
            }).outcome === 'unique_name_variant_match' &&
            findContradictoryProductAxes(item.name, [
              { field: 'heading', value: v.observedIdentity.pageName ?? '' },
              ...v.observedIdentity.variants.map((variant) => ({ field: 'variant', value: variant.label })),
            ]).length === 0) ?? null;
        const autoSelectedSource = autoSelectedResult?.candidate ?? null;
        const shouldAutoSelect = autoSelectedSource !== null;
        const selectedIdentity = autoSelectedResult
          ? matchOfficialPageIdentity({
              registerName: item.name,
              registerUpc: item.upc,
              brandHint: activeBrandHint,
              pageName: autoSelectedResult.observedIdentity.pageName ?? '',
              pageBrand: autoSelectedResult.observedIdentity.pageBrand,
              pageKind: autoSelectedResult.observedIdentity.pageKind,
              variants: autoSelectedResult.observedIdentity.variants,
              observedGtins: autoSelectedResult.observedIdentity.observedGtins,
            })
          : null;

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
        // Per-candidate auto-select junction (diagnostic capture): for every
        // verified-strong candidate, name which of the four strong-path
        // conjuncts (authority, coverage, matcher, contradiction) fails, so a
        // parked run names the exact failing gate instead of a generic suffix.
        const gateDiagnostics = verifiedStrong.map((v) => {
          const gates: string[] = [];
          if (!hasAuthority(v.candidate)) gates.push('no_authority');
          if (!v.observedIdentity.coverageComplete) gates.push('incomplete_coverage');
          const junctionIdentity = matchOfficialPageIdentity({
            registerName: item.name,
            registerUpc: item.upc,
            brandHint: activeBrandHint,
            pageName: v.observedIdentity.pageName ?? '',
            pageBrand: v.observedIdentity.pageBrand,
            pageKind: v.observedIdentity.pageKind,
            variants: v.observedIdentity.variants,
            observedGtins: v.observedIdentity.observedGtins,
          });
          if (junctionIdentity.outcome !== 'unique_name_variant_match') gates.push(`matcher:${junctionIdentity.outcome}(${junctionIdentity.reasons.join('+') || 'no_reasons'})`);
          const junctionContradictions = findContradictoryProductAxes(item.name, [
            { field: 'heading', value: v.observedIdentity.pageName ?? '' },
            ...v.observedIdentity.variants.map((variant) => ({ field: 'variant', value: variant.label })),
          ]);
          if (junctionContradictions.length) gates.push(`contradiction(${junctionContradictions.join('+')})`);
          return `${v.candidate.url} [${v.proofClass}] ${gates.length ? `BLOCKED:${gates.join(',')}` : 'PASS'}`;
        });
        const gateDetail = gateDiagnostics.length ? ` | gates: ${gateDiagnostics.join(' || ').slice(0, 2000)}` : '';

        updateDiscoveryRunStep(discoveryRunId, 'applying_outcome');

        if (shouldAutoSelect && autoSelectedSource && autoSelectedResult && selectedIdentity) {
          const resolvedUrl = autoSelectedSource.url;
          const autoSelectedInserted = insertedSources.find((s) => s.url === resolvedUrl);
          let committed = false;
          if (autoSelectedInserted) {
            try {
              recordOfficialPageDecision({
                workspaceId: this.workspaceId,
                itemId: item.id,
                sourceId: autoSelectedInserted.id,
                evidenceKind: autoSelectedResult.proofClass !== 'none' ? 'observed_gtin' : 'automatic_name',
                pageTitle: selectedIdentity.pageName,
                variantKey: selectedIdentity.variantKey,
                signals: {
                  identity: selectedIdentity,
                  observedIdentity: autoSelectedResult.observedIdentity,
                  proofClass: autoSelectedResult.proofClass,
                  decisionReason: autoSelectedResult.decisionReason,
                },
                sourceRunId: discoveryRunId,
                expectedUpdatedAt: item.updatedAt,
                expectedClaimedBy: this.workerId,
              });
              committed = true;
            } catch (err) {
              console.warn(`[OnboardingWorker] Auto-select decision record failed for ${item.id}; parking for manual review:`, err);
            }
          }
          if (committed) {
            completeDiscoveryRun(
              discoveryRunId,
              'auto_selected',
              `Auto-selected verified source: ${resolvedUrl} (${autoSelectedResult.decisionReason})`,
            );
            console.log(
              `[OnboardingWorker] ✓ Auto-selected verified source for "${item.name}" (${item.upc}): ` +
              `${resolvedUrl} (${autoSelectedResult.decisionReason})`
            );
          } else {
            const reason = 'needs_review: automatic confirmation could not be committed';
            completeDiscoveryRun(discoveryRunId, 'needs_input_candidates', reason);
            updateItemStageStatus(item.id, 'completed', reason);
            console.log(`[OnboardingWorker] ⚠ Discovery needs manual review for "${item.name}" (${item.upc}): ${reason}`);
          }
        } else if (!shouldAutoSelect) {
          // Build a detailed reason that includes verification signals
          // so the reviewer knows WHY auto-selection was skipped.
          const topVerification = verificationResults[0];
          const verificationDetail = topVerification
            ? ` | verification: ${topVerification.decisionReason}`
            : '';
          completeDiscoveryRun(
            discoveryRunId,
            'needs_input_candidates',
            `No candidate passed verification — needs manual URL review${verificationDetail}${authorityDetail}${killSwitchDetail}${gateDetail}`,
          );
          const manualReviewReason =
            `needs_review: no candidate passed verification${verificationDetail}${authorityDetail}${killSwitchDetail}${gateDetail}`;
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
              killSwitchDetail +
              gateDetail,
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
  private async processOfficialIdentityBootstrap(
    item: any,
    claim: ClaimedItemExtractionLease,
    assertHeld: () => void,
  ): Promise<void> {
    const needsInput = (reason: string): void => {
      const message = reason.slice(0, 500);
      if (requireClaimedItemExtractionInput(item.id, claim, message)) {
        onboardingEvents.emitItemStatus(item.batchId, item.id, 'needs_input', { stage: 'collect_details', error: message });
      }
    };
    let runId: string | null = null;
    try {
      assertHeld();
      const decisions = listOfficialPageDecisions(item.id);
      const decision = decisions.find(candidate =>
        candidate.workspaceId === this.workspaceId && candidate.itemId === item.id && candidate.url === item.sourceUrl,
      );
      const domains = getAllowedOfficialPageDomains({
        workspaceId: this.workspaceId,
        itemId: item.id,
        brandHint: item.brandHint ?? null,
      });
      if (
        !item.sourceUrl || !decision ||
        !isAuthorizedOfficialPageUrl(item.sourceUrl, domains) ||
        !['automatic_name', 'operator_name', 'observed_gtin'].includes(decision.evidenceKind)
      ) {
        needsInput('A current confirmed official page and approved manufacturer authority are required for identity evidence collection.');
        return;
      }
      const initialEvidence = refreshItemEvidence(this.workspaceId, item.id);
      if (initialEvidence.status === 'stale') {
        releaseClaimedItemExtraction(item.id, claim);
        return;
      }
      if (initialEvidence.status === 'conflict') {
        needsInput(initialEvidence.findings.map(finding => finding.reason).join('; ') || 'Current item evidence contains an identity or source conflict.');
        return;
      }
      const acceptedEvidence = initialEvidence.status === 'accepted' ? initialEvidence.evidence : null;
      const run = createItemAcquisitionRun({
        item,
        workspaceId: this.workspaceId,
        workspacePath: this.workspacePath,
        inputRevision: claim.inputRevision,
        evidence: acceptedEvidence,
        assertHeld,
      });
      runId = run.run.id;
      const acquisition = await withItemAcquisitionBudget(
        { workspaceId: this.workspaceId, itemId: item.id, runId, assertHeld },
        () => runItemEvidenceAcquisition({
          workspaceId: this.workspaceId,
          itemId: item.id,
          runId: run.run.id,
          intent: 'identity_bootstrap',
          assertHeld,
          modelPolicy: run.modelPolicy ?? undefined,
        }),
      );
      assertHeld();
      if (acquisition.status === 'stale' || acquisition.status === 'cancelled') {
        finishItemAcquisitionRun(runId, 'failed', acquisition.reason ?? 'Bootstrap evidence acquisition became stale.');
        releaseClaimedItemExtraction(item.id, claim);
        return;
      }
      if (acquisition.status !== 'completed') {
        finishItemAcquisitionRun(runId, 'completed', acquisition.reason);
        needsInput(acquisition.reason ?? 'Current official identity evidence is incomplete and needs operator resolution.');
        return;
      }
      const refreshed = refreshItemEvidence(this.workspaceId, item.id);
      const evidence = refreshed.evidence;
      if (
        refreshed.status !== 'accepted' || !evidence ||
        !acquisition.evidence ||
        evidence.id !== acquisition.evidence.id ||
        evidence.revision !== acquisition.evidence.revision ||
        evidence.evidenceHash !== acquisition.evidence.evidenceHash ||
        evidence.inputHash !== acquisition.evidence.inputHash ||
        !evidence.facts.some(fact => fact.field === 'title')
      ) {
        finishItemAcquisitionRun(runId, 'failed', 'Accepted identity evidence changed or remained incomplete after acquisition.');
        needsInput(refreshed.findings.map(finding => finding.reason).join('; ') || 'A complete accepted product title and current matching identity evidence are required.');
        return;
      }
      const extractionData = acceptedEvidenceExtractionProjection(evidence, item.sourceUrl);
      assertHeld();
      const committed = commitClaimedItemExtraction(item.id, claim, JSON.stringify(extractionData), () => {
        const currentEvidence = getCurrentItemEvidenceView(this.workspaceId, item.id);
        if (
          currentEvidence.status !== 'accepted' || !currentEvidence.evidence ||
          currentEvidence.evidence.id !== evidence.id ||
          currentEvidence.evidence.revision !== evidence.revision ||
          currentEvidence.evidence.evidenceHash !== evidence.evidenceHash ||
          currentEvidence.evidence.inputHash !== evidence.inputHash
        ) throw new ItemCurationLeaseLostError('Accepted identity evidence changed before Extraction commit.');
        insertExtraction({
          itemId: item.id,
          sourceUrl: item.sourceUrl,
          extractionDataJson: JSON.stringify(extractionData),
          extractionMethod: 'accepted_item_evidence_bootstrap',
          confidence: 0,
          imagesJson: null,
          rawStructuredDataJson: JSON.stringify(extractionData.acceptedEvidenceProvenance),
        });
        finishItemAcquisitionRun(runId!, 'completed');
      });
      if (!committed) {
        finishItemAcquisitionRun(runId, 'failed', 'The Extraction item lease or input changed before commit.');
        releaseClaimedItemExtraction(item.id, claim);
        return;
      }
      onboardingEvents.emitItemStatus(item.batchId, item.id, 'completed', {
        stage: 'collect_details',
        extractedData: extractionData,
        evidenceSnapshotId: evidence.id,
        evidenceRevision: evidence.revision,
      });
    } catch (error) {
      if (runId) {
        try { finishItemAcquisitionRun(runId, 'failed', 'Identity bootstrap did not complete under its current item lease.'); } catch { /* immutable run may already be terminal */ }
      }
      if (error instanceof ItemCurationLeaseLostError) {
        releaseClaimedItemExtraction(item.id, claim);
        return;
      }
      const message = error instanceof Error ? redactTransportText(error.message) : 'Identity bootstrap failed.';
      needsInput(message);
    }
  }
  private async processConfirmedPageStaticExtraction(
    item: any,
    claim: ClaimedItemExtractionLease,
    assertHeld: () => void,
  ): Promise<void> {
    const needsInput = (reason: string): void => {
      if (requireClaimedItemExtractionInput(item.id, claim, reason.slice(0, 500))) {
        onboardingEvents.emitItemStatus(item.batchId, item.id, 'needs_input', { stage: 'collect_details', error: reason.slice(0, 500) });
      }
    };
    try {
      assertHeld();
      const decision = listOfficialPageDecisions(item.id).find((entry) =>
        entry.workspaceId === this.workspaceId &&
        entry.itemId === item.id &&
        entry.url === item.sourceUrl &&
        Boolean(entry.sourceRunId),
      );
      const selectedSource = decision && listSourcesByItem(item.id).find((entry) =>
        entry.url === decision.url &&
        entry.isSelected &&
        entry.discoveryRunId === decision.sourceRunId,
      );
      const domains = getAllowedOfficialPageDomains({
        workspaceId: this.workspaceId,
        itemId: item.id,
        brandHint: item.brandHint ?? null,
      });
      if (!item.sourceUrl || !decision || !selectedSource || !isAuthorizedOfficialPageUrl(item.sourceUrl, domains)) {
        needsInput('A current confirmed page, selected source, discovery run, and approved manufacturer authority are required.');
        return;
      }
      const detailed = await extractConfirmedPageStatic(item.sourceUrl, {
        name: item.expectedName || item.name,
        brandHint: item.brandHint ?? null,
        gtin: item.upc ?? undefined,
      }, createDiscoveryFetch(domains));
      assertHeld();
      const currentDomains = getAllowedOfficialPageDomains({
        workspaceId: this.workspaceId,
        itemId: item.id,
        brandHint: item.brandHint ?? null,
      });
      const decisionStillCurrent = listOfficialPageDecisions(item.id).some((entry) =>
        entry.id === decision.id &&
        entry.workspaceId === this.workspaceId &&
        entry.url === item.sourceUrl &&
        entry.sourceRunId === decision.sourceRunId,
      );
      const sourceStillCurrent = listSourcesByItem(item.id).some((entry) =>
        entry.id === selectedSource.id &&
        entry.url === item.sourceUrl &&
        entry.isSelected &&
        entry.discoveryRunId === decision.sourceRunId,
      );
      if (!decisionStillCurrent || !sourceStillCurrent || !isAuthorizedOfficialPageUrl(item.sourceUrl, currentDomains)) {
        needsInput('The confirmed page or approved manufacturer authority changed during static extraction.');
        return;
      }
      const data = detailed.data;
      const extractedVariantKey = data.selectedVariant?.selectedVariantKey ?? null;
      if (decision.variantKey && extractedVariantKey !== decision.variantKey) {
        needsInput('The static page does not provide the exact confirmed variant receipt.');
        return;
      }
      const validation = validateExtraction(data, {
        name: item.expectedName || item.name,
        brandHint: item.brandHint ?? null,
        upc: item.upc ?? null,
        selectedVariantKey: decision.variantKey,
        extractedVariantKey,
      });
      if (!validation.valid || !data.title) {
        needsInput(validation.reason ?? 'Static page extraction did not establish the confirmed product identity.');
        return;
      }
      data.price = null;
      const dataJson = JSON.stringify(data);
      getDb().transaction(() => {
        insertExtraction({
          itemId: item.id,
          sourceUrl: item.sourceUrl,
          extractionDataJson: dataJson,
          extractionMethod: 'confirmed_page_static',
          confidence: data.confidence,
          imagesJson: null,
          rawStructuredDataJson: JSON.stringify(data.fieldProvenance),
        });
        getDb().query('UPDATE onboarding_items SET extraction_data_json = ?, updated_at = ? WHERE id = ?')
          .run(dataJson, new Date().toISOString(), item.id);
      })();
      const admitted = refreshItemEvidence(this.workspaceId, item.id);
      if (admitted.status !== 'accepted' || !admitted.evidence?.facts.some((fact) => fact.field === 'title')) {
        needsInput(admitted.findings.map((entry) => entry.reason).join('; ') || 'Static source observations were not admitted as current item evidence.');
        return;
      }
      if (!commitClaimedItemExtraction(item.id, claim, dataJson)) {
        releaseClaimedItemExtraction(item.id, claim);
        return;
      }
      onboardingEvents.emitItemStatus(item.batchId, item.id, 'completed', {
        stage: 'collect_details',
        extractedData: data,
        evidenceSnapshotId: admitted.evidence.id,
        evidenceRevision: admitted.evidence.revision,
      });
    } catch (error) {
      const reason = error instanceof Error ? redactTransportText(error.message) : 'Confirmed-page static extraction failed.';
      needsInput(reason);
    }
  }



  private async processExtraction(item: any): Promise<void> {
    this.extractionRunning++;
    const done = () => { this.extractionRunning = Math.max(0, this.extractionRunning - 1); };
    const claim: ClaimedItemExtractionLease = {
      workerId: this.workerId,
      claimedAt: typeof item.claimedAt === 'string' ? item.claimedAt : '',
      inputRevision: typeof item.inputRevision === 'string' ? item.inputRevision : '',
    };
    if (!claim.claimedAt || !claim.inputRevision || item.claimedBy !== this.workerId) {
      done();
      return;
    }
    const assertHeld = (): void => {
      if (this.stopped) throw new ItemCurationLeaseLostError('Worker stopped during item Extraction.');
      const current = findItemById(item.id);
      const batch = findBatchById(item.batchId);
      if (
        !current || current.claimedBy !== claim.workerId || current.claimedAt !== claim.claimedAt ||
        current.inputRevision !== claim.inputRevision || current.stageStatus !== 'in_progress' ||
        !storedStageIs(current.stage, 'collect_details') || !batch || batch.status !== 'active' ||
        (batch.executionState !== 'running' && batch.executionState !== null)
      ) throw new ItemCurationLeaseLostError('The Extraction item claim, input, stage, or active batch state changed.');
    };
    try {
      assertHeld();
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
        if (requireClaimedItemExtractionInput(item.id, claim, 'No confirmed source URL is bound to this item.')) {
          onboardingEvents.emitItemStatus(item.batchId, item.id, 'needs_input', {
            stage: 'collect_details',
            error: 'No confirmed source URL is bound to this item.',
          });
        }
        return;
      }

      const currentDecision = listOfficialPageDecisions(item.id).find((decision) =>
        decision.workspaceId === this.workspaceId &&
        decision.itemId === item.id &&
        decision.url === item.sourceUrl &&
        Boolean(decision.sourceRunId),
      );
      const currentSource = currentDecision && listSourcesByItem(item.id).find((source) =>
        source.url === currentDecision.url &&
        source.isSelected &&
        source.discoveryRunId === currentDecision.sourceRunId,
      );
      let approvedPage = false;
      try {
        approvedPage = Boolean(currentDecision && currentSource && isAuthorizedOfficialPageUrl(
          item.sourceUrl,
          getAllowedOfficialPageDomains({ workspaceId: this.workspaceId, itemId: item.id, brandHint: item.brandHint ?? null }),
        ));
      } catch { /* unavailable authority fails closed below */ }
      if (!approvedPage) {
        const message = 'Source URL is not bound to a current official decision, selected source, discovery run, and approved manufacturer authority.';
        if (requireClaimedItemExtractionInput(item.id, claim, message)) {
          onboardingEvents.emitItemStatus(item.batchId, item.id, 'needs_input', { stage: 'collect_details', error: message });
        }
        return;
      }

      let domain = '';
      try {
        domain = new URL(item.sourceUrl).hostname.replace(/^www\./, '');
      } catch {
        // Keep the empty domain so the missing-profile failure below remains explicit.
      }
      try {
        resolveExecutableProfile(domain);
      } catch (error) {
        if (error instanceof Error && /^No extractor profile for .+ — profile required/.test(error.message)) {
          await this.processConfirmedPageStaticExtraction(item, claim, assertHeld);
        } else {
          if (failClaimedItemExtraction(item.id, claim, 'The approved extraction profile could not be resolved.')) {
            onboardingEvents.emitItemStatus(item.batchId, item.id, 'failed', { stage: 'collect_details', error: 'The approved extraction profile could not be resolved.' });
          }
        }
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
        const extract = this.deps?.extractProductData ?? extractProductData;
        const extractedData = await extract(item.sourceUrl, {
          name: item.expectedName || item.name,
          brandHint: item.brandHint,
          // ADR-0031: enables real identity classification in ladder enrichment.
          // (ADR 0043: no input price is forwarded — matching uses identity
          // evidence only, and extraction never carries prices.)
          gtin: item.upc || undefined,
          variantSelection,
        });

        if (item.brandHint && !extractedData.brand) extractedData.brand = item.brandHint;
        // Input Price Authority (ADR 0043): extraction NEVER carries an
        // input price and NEVER backfills from one. The item price flows
        // straight from input to draft; page prices stay observations, not
        // authorities.

        // ADR 0040 extraction revalidation: a confirmed source URL is only
        // as fresh as the page behind it. Changed/conflicting pages and
        // stale variant receipts fail closed (no extraction persisted, no
        // blind retry); ambiguous pages park for operator review. An
        // unconfirmed source URL never reaches extraction.
        const decisions = (() => {
          try {
            return listOfficialPageDecisions(item.id);
          } catch {
            return [];
          }
        })();
        const confirmed = decisions.find((decision) => {
          if (
            decision.workspaceId !== this.workspaceId ||
            decision.itemId !== item.id ||
            decision.url !== item.sourceUrl ||
            !decision.sourceRunId
          ) return false;
          return listSourcesByItem(item.id).some((source) =>
            source.url === decision.url &&
            source.isSelected &&
            source.discoveryRunId === decision.sourceRunId,
          );
        }) ?? null;
        if (!confirmed) {
          updateItemStageStatus(item.id, 'needs_input', 'Source URL is not bound to a current confirmed official page, selected source, and discovery run');
          onboardingEvents.emitItemStatus(item.batchId, item.id, 'needs_input', {
            stage: 'collect_details',
            error: 'Source URL is not bound to a current confirmed official page, selected source, and discovery run',
          });
          return;
        }
        let currentAuthority = false;
        try {
          currentAuthority = isAuthorizedOfficialPageUrl(
            item.sourceUrl,
            getAllowedOfficialPageDomains({
              workspaceId: this.workspaceId,
              itemId: item.id,
              brandHint: item.brandHint ?? null,
            }),
          );
        } catch { /* authority failure is a closed progression below */ }
        if (!currentAuthority) {
          updateItemStageStatus(item.id, 'needs_input', 'Approved manufacturer authority changed during page extraction');
          onboardingEvents.emitItemStatus(item.batchId, item.id, 'needs_input', {
            stage: 'collect_details',
            error: 'Approved manufacturer authority changed during page extraction',
          });
          return;
        }
        const extractedVariant = (extractedData as unknown as {
          selectedVariant?: { selectedVariantKey?: string; variantKey?: string } | null;
        }).selectedVariant ?? null;
        const revalidation = validateExtraction(extractedData, {
          name: item.expectedName || item.name,
          brandHint: item.brandHint ?? null,
          upc: item.upc ?? null,
          selectedVariantKey: confirmed.variantKey,
          extractedVariantKey: extractedVariant?.selectedVariantKey ?? extractedVariant?.variantKey ?? null,
        });
        if (!revalidation.valid) {
          const reason = revalidation.reason ?? 'identity revalidation failed';
          const needsOperator = reason.includes('needs operator');
          updateItemStageStatus(item.id, needsOperator ? 'needs_input' : 'failed', reason);
          onboardingEvents.emitItemStatus(item.batchId, item.id, needsOperator ? 'needs_input' : 'failed', {
            stage: 'collect_details',
            error: reason,
          });
          return;
        }

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
          `confidence=${(extractedData.confidence * 100).toFixed(0)}%, ` +
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

  private async processCuration(item: OnboardingItemWithEntryPolicy): Promise<void> {
    const claim: ClaimedItemCurationLease = {
      workerId: this.workerId,
      claimedAt: typeof item.claimedAt === 'string' ? item.claimedAt : '',
      inputRevision: typeof item.inputRevision === 'string' ? item.inputRevision : '',
    };
    if (!claim.claimedAt || !claim.inputRevision || item.claimedBy !== this.workerId) return;

    let acceptedEvidence: AcceptedItemEvidence | null = null;
    const assertHeld = (): void => {
      if (this.stopped) throw new ItemCurationLeaseLostError('Worker stopped while item curation was running.');
      const current = findItemById(item.id);
      const batch = findBatchById(item.batchId);
      if (
        !current ||
        current.claimedBy !== claim.workerId ||
        current.claimedAt !== claim.claimedAt ||
        current.inputRevision !== claim.inputRevision ||
        current.stageStatus !== 'in_progress' ||
        !storedStageIs(current.stage, 'prepare_listing') ||
        !batch ||
        batch.workspaceId !== this.workspaceId ||
        batch.status !== 'active' ||
        batch.executionState !== 'running'
      ) {
        throw new ItemCurationLeaseLostError('The item claim or active batch state changed during curation.');
      }
      if (acceptedEvidence) {
        const currentEvidence = getCurrentItemEvidenceView(this.workspaceId, item.id);
        if (
          !currentEvidence.evidence ||
          currentEvidence.status === 'stale' ||
          currentEvidence.status === 'conflict' ||
          currentEvidence.evidence.id !== acceptedEvidence.id ||
          currentEvidence.evidence.revision !== acceptedEvidence.revision ||
          currentEvidence.evidence.evidenceHash !== acceptedEvidence.evidenceHash ||
          currentEvidence.evidence.inputHash !== acceptedEvidence.inputHash ||
          currentEvidence.evidence.sourceStateHash !== acceptedEvidence.sourceStateHash ||
          currentEvidence.evidence.authorityHash !== acceptedEvidence.authorityHash
        ) {
          throw new ItemCurationLeaseLostError('Accepted item evidence changed during curation.');
        }
      }
    };
    const release = (reason: string): void => {
      if (releaseClaimedItemCuration(item.id, claim)) {
        onboardingEvents.emitItemStatus(item.batchId, item.id, 'pending', { stage: 'prepare_listing', error: reason });
      }
    };
    const fail = (reason: string): void => {
      if (failClaimedItemCuration(item.id, claim, reason.slice(0, 500))) {
        onboardingEvents.emitItemStatus(item.batchId, item.id, 'failed', { stage: 'prepare_listing', error: reason.slice(0, 500) });
      }
    };

    try {
      assertHeld();
      const evidenceResult = refreshItemEvidence(this.workspaceId, item.id);
      if (evidenceResult.status === 'stale') {
        release('Accepted item evidence changed; item returned to pending for a fresh run.');
        return;
      }
      if (evidenceResult.status === 'conflict') {
        fail(evidenceResult.findings[0]?.reason ?? 'Accepted item evidence has an unresolved conflict.');
        return;
      }
      if (!evidenceResult.evidence) {
        fail(evidenceResult.findings[0]?.reason ?? 'Current accepted item evidence is unavailable.');
        return;
      }
      acceptedEvidence = evidenceResult.evidence;
      assertHeld();

      let strategyEnvelope: { envelope: StrategyCollectionResult; hash: string } | null = null;
      if (item.sourceType === 'distributor_record') {
        try {
          const generation = getCurrentSourcingGeneration(item.id);
          strategyEnvelope = generation ? getStrategyCollectionResult(generation.id) : null;
        } catch (error) {
          const code = error instanceof Error ? (error as Error & { code?: string }).code ?? 'invalid_envelope' : 'invalid_envelope';
          if (code !== 'missing_envelope') throw new Error(`strategy_collection:${code}`, { cause: error });
        }
      }
      const gapAtStart = getPreparationGap(item.id);
      const correction = gapAtStart?.status === 'open' ? gapAtStart.correctionEnvelope : null;
      const correctionOverlay: GapCorrectionOverlay | null =
        correction && (correction.status === 'recorded' || correction.status === 'preparing')
          ? {
              values: correction.values,
              correctionHash: correction.correctionHash,
              actor: correction.actor,
              revision: correction.revision,
            }
          : null;
      const curationData = await curateItemWithPipeline(item, this.workspacePath, this.workspaceId, correctionOverlay, {
        assertHeld,
        inputRevision: claim.inputRevision,
        acceptedEvidence,
      });

      assertHeld();

      const refreshedEvidence = refreshItemEvidence(this.workspaceId, item.id);
      if (
        !refreshedEvidence.evidence ||
        refreshedEvidence.status === 'stale' ||
        refreshedEvidence.status === 'conflict' ||
        refreshedEvidence.evidence.id !== acceptedEvidence.id ||
        refreshedEvidence.evidence.revision !== acceptedEvidence.revision ||
        refreshedEvidence.evidence.evidenceHash !== acceptedEvidence.evidenceHash ||
        refreshedEvidence.evidence.inputHash !== acceptedEvidence.inputHash ||
        refreshedEvidence.evidence.sourceStateHash !== acceptedEvidence.sourceStateHash ||
        refreshedEvidence.evidence.authorityHash !== acceptedEvidence.authorityHash
      ) {
        release('Accepted item evidence changed during curation; item returned to pending for a fresh run.');
        return;
      }
      assertHeld();

      const beforeCommit = (): void => {
        const commitEvidence = getCurrentItemEvidenceView(this.workspaceId, item.id);
        if (
          !commitEvidence.evidence ||
          commitEvidence.status === 'stale' ||
          commitEvidence.status === 'conflict' ||
          commitEvidence.evidence.id !== acceptedEvidence!.id ||
          commitEvidence.evidence.revision !== acceptedEvidence!.revision ||
          commitEvidence.evidence.evidenceHash !== acceptedEvidence!.evidenceHash ||
          commitEvidence.evidence.inputHash !== acceptedEvidence!.inputHash ||
          commitEvidence.evidence.sourceStateHash !== acceptedEvidence!.sourceStateHash ||
          commitEvidence.evidence.authorityHash !== acceptedEvidence!.authorityHash
        ) {
          throw new ItemCurationLeaseLostError('Accepted item evidence changed before curation commit.');
        }
        const liveGap = getPreparationGap(item.id);
        const activeCorrection = liveGap?.status === 'open' ? liveGap.correctionEnvelope : null;
        if (
          (correctionOverlay &&
            (!activeCorrection ||
              activeCorrection.revision !== correctionOverlay.revision ||
              activeCorrection.correctionHash !== correctionOverlay.correctionHash)) ||
          (!correctionOverlay &&
            activeCorrection &&
            (activeCorrection.status === 'recorded' || activeCorrection.status === 'preparing'))
        ) {
          throw Object.assign(new Error('Preparation correction changed during validation.'), { code: 'stale_gap' });
        }
        if (!strategyEnvelope && !hasUnresolvedPreparationGap(item.id)) return;
        const fields = {
          title: curationData.curatedTitle,
          description: curationData.curatedDescription,
        };
        const { missing } = assessListingEvidenceGap({
          consolidatedFields: fields,
          requiredFields: blockingPreparationFields(loadPreparationRulesConfig(this.workspacePath)),
        });
        if (missing.length > 0) {
          openPreparationGap({
            workspaceId: this.workspaceId,
            itemId: item.id,
            batchId: item.batchId,
            collectionResultVersion: 'strategy-collection-v1',
            missingFields: missing,
            reason: `Preparation is still missing required listing information: ${missing.join(', ')}.`,
            evidenceHash: strategyEnvelope?.hash ?? liveGap?.evidenceHash ?? null,
          });
          if (correctionOverlay) {
            markCorrectionRun({
              itemId: item.id,
              revision: correctionOverlay.revision,
              runId: curationData.classificationRunId ?? null,
              status: 'failed',
            });
          }
        } else if (liveGap?.status === 'open') {
          resolveAfterValidation({
            itemId: item.id,
            revision: correctionOverlay?.revision ?? 0,
            correctionHash: correctionOverlay?.correctionHash ?? '',
            evidenceHash: strategyEnvelope?.hash ?? liveGap.evidenceHash ?? null,
            resolvedBy: correctionOverlay?.actor ?? 'preparation-validation',
          });
        }
      };

      if (!commitClaimedItemCuration(item.id, claim, JSON.stringify(curationData), beforeCommit)) {
        release('The item claim or input changed before its curation output could be committed.');
        return;
      }
      onboardingEvents.emitItemStatus(item.batchId, item.id, 'completed', {
        stage: 'prepare_listing',
        curationData,
      });
      console.log(
        `[OnboardingWorker] ✓ Curation complete for "${item.name}" (${item.upc}): ` +
          `curatedTitle="${curationData.curatedTitle || 'N/A'}", ` +
          `titleSource=${curationData.titleSource}, ` +
          `suggestedPages=[${(curationData.suggestedPages || []).join(', ') || 'none'}], ` +
          `productType=${curationData.suggestedProductType || 'N/A'}`,
      );
    } catch (error) {
      if (
        error instanceof ItemCurationLeaseLostError ||
        (error instanceof Error && ['stale_gap', 'item_evidence_stale'].includes((error as Error & { code?: string }).code ?? ''))
      ) {
        release(error.message);
        return;
      }
      console.error(`[OnboardingWorker] Curation error for ${item.id}:`, error);
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}
