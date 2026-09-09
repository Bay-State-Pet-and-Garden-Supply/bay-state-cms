/**
 * Epic #46 — onboarding observability (batch + global success metrics).
 *
 * Every metric is DERIVED from existing durable state at query time — no
 * event plumbing. Each metric carries an honesty marker:
 *   exact          — derived directly from durable state;
 *   approximation  — closest deterministic derivation from available state;
 *   not_available  — genuinely underivable without new event capture.
 *
 * The metrics answer "is automation working, and where are humans spending
 * time?" per the epic's Observability section:
 *   automation rate, attention volume + reasons, distributor-only success,
 *   official-site requirement, extractor-profile block rate + domain
 *   unblocks, family waits + duration, cohort curation success, review
 *   throughput + edit rate, bulk approval success, export success.
 */
import { getDb } from '../db/connection';
import { listBatches, findBatchById } from '../db/repositories/onboarding-batch-repo';
import { listItemsByBatch } from '../db/repositories/onboarding-item-repo';
import {
  listReviewStates,
  type OnboardingReviewState,
} from '../db/repositories/onboarding-review-repo';
import {
  listCohortsByBatch,
  listCohortsByWorkspace,
} from '../db/repositories/curation-cohort-repo';
import { listCohortRunsByCohort } from '../db/repositories/classification-cohort-run-repo';
import { toCanonicalStage } from '../shared/onboarding-stage-vocabulary';

/** Slice 5b native: canonical promotion check for hydrated stages (dual read). */
function isPromotedStage(rawStage: unknown, stageStatus: unknown): boolean {
  try {
    return toCanonicalStage(rawStage) === 'create_drafts' && stageStatus === 'completed';
  } catch {
    return false;
  }
}
import {
  listChangeSetStatusBySkus,
  listChangeSetCountsByState,
} from '../db/repositories/change-set-repo';
import { countAuditLogsByAction } from '../db/repositories/audit-log-repo';
import {
  buildBatchWorkStateContext,
  deriveItemWorkState,
} from './onboarding-work-state';
import type { OnboardingItem } from '../shared/schemas/onboarding';
import type {
  OnboardingWorkState,
  WorkStateCategory,
} from '../shared/schemas/onboarding-work-state';
import {
  type OnboardingTelemetry,
  type TelemetryMetric,
  type MetricBreakdownEntry,
  type MetricDerivation,
} from '../shared/schemas/onboarding-telemetry';

export interface OnboardingMetricsInput {
  workspaceId: string;
  /** Omit for global scope. */
  batchId?: string;
}

// ─── Derivation constants ──────────────────────────────────────────────────────

/** Categories that count as "automation finished; human QA/release territory". */
const COMPLETION_CATEGORIES: ReadonlySet<WorkStateCategory> = new Set([
  'ready_for_review',
  'approved',
  'ready_to_export',
  'completed',
]);

/** Terminal cohort-run outcomes treated as SUCCESS (issue #30 PR3 M3). */
const COHORT_RUN_SUCCESS: ReadonlySet<string> = new Set([
  'completed',
  'completed_with_abstentions',
  'completed_with_member_failures',
]);

/** Terminal cohort-run outcomes treated as FAILURE. */
const COHORT_RUN_FAILURE: ReadonlySet<string> = new Set(['failed', 'cancelled']);

/** Change-set states that expose the export decision surface. */
const CHANGE_SET_ACTIVE_STATES: ReadonlySet<string> = new Set([
  'draft',
  'reviewing',
  'approved',
  'pushed',
]);

function toEpochMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function metric(
  value: number | null,
  unit: string | null,
  derivation: MetricDerivation,
  note: string | null = null,
  breakdown: MetricBreakdownEntry[] = [],
): TelemetryMetric {
  return { value, unit, derivation, note, breakdown };
}

function divide(num: number, den: number): number {
  return den > 0 ? num / den : 0;
}

// ─── Scope aggregation ─────────────────────────────────────────────────────────

interface BatchSlice {
  batchId: string;
  batchStartMs: number;
  items: OnboardingItem[];
  states: OnboardingWorkState[];
  reviewStates: Map<string, OnboardingReviewState>;
  cohortIds: string[];
}

/** Load one batch's items + full work-state projection context (one pass). */
function loadBatchSlice(batchId: string, fallbackStartMs: number): BatchSlice {
  const items = listItemsByBatch(batchId);
  const ctx = buildBatchWorkStateContext(batchId, items);
  const states = items.map(item => deriveItemWorkState(item, ctx));
  const batch = findBatchById(batchId);
  const batchStartMs = toEpochMs(batch?.createdAt) ?? fallbackStartMs;
  const cohorts = listCohortsByBatch(batchId);
  return {
    batchId,
    batchStartMs,
    items,
    states,
    reviewStates: listReviewStates(batchId),
    cohortIds: cohorts.map(cohort => cohort.id),
  };
}

interface Aggregated {
  totalItems: number;
  skippedCount: number;
  completionPool: number;
  distributorCompleted: number;
  officialCompleted: number;
  attentionCount: number;
  attentionByReason: Map<string, number>;
  profileBlockCount: number;
  waitingFamilyCount: number;
  readyForReviewCount: number;
  reviewedCount: number;
  approvedCount: number;
  invalidatedCount: number;
  cohortSuccess: number;
  cohortFailure: number;
  readyCohortDurationsMs: number[];
  promotedSkuStatuses: Map<string, string>;
  earliestBatchStartMs: number | null;
}

function emptyAggregate(): Aggregated {
  return {
    totalItems: 0,
    skippedCount: 0,
    completionPool: 0,
    distributorCompleted: 0,
    officialCompleted: 0,
    attentionCount: 0,
    attentionByReason: new Map(),
    profileBlockCount: 0,
    waitingFamilyCount: 0,
    readyForReviewCount: 0,
    reviewedCount: 0,
    approvedCount: 0,
    invalidatedCount: 0,
    cohortSuccess: 0,
    cohortFailure: 0,
    readyCohortDurationsMs: [],
    promotedSkuStatuses: new Map(),
    earliestBatchStartMs: null,
  };
}

function aggregateBatch(slices: BatchSlice[], workspaceId: string): Aggregated {
  const agg = emptyAggregate();
  for (const slice of slices) {
    agg.totalItems += slice.items.length;
    if (agg.earliestBatchStartMs === null || slice.batchStartMs < agg.earliestBatchStartMs) {
      agg.earliestBatchStartMs = slice.batchStartMs;
    }

    for (const state of slice.states) {
      if (state.category === 'skipped') {
        agg.skippedCount += 1;
        continue;
      }
      if (COMPLETION_CATEGORIES.has(state.category)) {
        agg.completionPool += 1;
        if (state.sourceType === 'distributor_record') agg.distributorCompleted += 1;
        if (state.sourceType === 'official_page') agg.officialCompleted += 1;
        if (state.category === 'ready_for_review') agg.readyForReviewCount += 1;
      }
      if (state.category === 'needs_attention') {
        agg.attentionCount += 1;
        const reason = state.attentionReason ?? 'unspecified';
        agg.attentionByReason.set(reason, (agg.attentionByReason.get(reason) ?? 0) + 1);
        if (state.attentionReason === 'extractor_profile_required' || state.attentionReason === 'extraction_profile_failed') {
          agg.profileBlockCount += 1;
        }
      }
      if (state.category === 'waiting_on_family') agg.waitingFamilyCount += 1;
    }

    for (const row of slice.reviewStates.values()) {
      if (row.reviewedAt) agg.reviewedCount += 1;
      if (row.approvedAt) agg.approvedCount += 1;
      if (row.reviewInvalidatedAt) agg.invalidatedCount += 1;
    }

    // Cohort execution + family wait durations (ADR 0013 durable families).
    for (const cohortId of slice.cohortIds) {
      for (const run of listCohortRunsByCohort(cohortId)) {
        if (COHORT_RUN_SUCCESS.has(run.status)) agg.cohortSuccess += 1;
        else if (COHORT_RUN_FAILURE.has(run.status)) agg.cohortFailure += 1;
      }
    }
  }

  // Family wait duration: ready cohorts' (ready ≈ updated_at) - created_at.
  // `updateCohortStatus('ready')` writes updated_at, so for cohorts currently
  // `ready` this is the deterministic ready-time approximation (a refresh
  // that leaves a waiting cohort touching updated_at is the documented drift).
  const cohortRows = slices.length === 1 && slices[0]
    ? listCohortsByBatch(slices[0].batchId)
    : listCohortsByWorkspace(workspaceId);
  for (const cohort of cohortRows) {
    if (cohort.status !== 'ready') continue;
    const createdMs = toEpochMs(cohort.createdAt);
    const readyMs = toEpochMs(cohort.updatedAt);
    if (createdMs !== null && readyMs !== null && readyMs > createdMs) {
      agg.readyCohortDurationsMs.push(readyMs - createdMs);
    }
  }

  // Promoted items' change-set statuses (batch export success denominator),
  // scoped to THIS workspace (epic #46 fix 3): identical SKUs in other
  // workspaces must never contribute their change-set lifecycle.
  for (const slice of slices) {
    const promotedSkus = slice.items
      .filter(item => isPromotedStage(item.stage, item.stageStatus))
      .map(item => item.upc);
    if (promotedSkus.length === 0) continue;
    for (const [sku, status] of listChangeSetStatusBySkus(workspaceId, promotedSkus)) {
      if (!CHANGE_SET_ACTIVE_STATES.has(status)) continue;
      agg.promotedSkuStatuses.set(sku, status);
    }
  }

  return agg;
}

// ─── Metric builders ───────────────────────────────────────────────────────────

function buildMetrics(
  agg: Aggregated,
  workspaceId: string,
  scope: 'batch' | 'global',
  batchId?: string | null,
): OnboardingTelemetry['metrics'] {
  const activeItems = agg.totalItems - agg.skippedCount;

  // automationToReviewRate: the automation-finished pool over active items.
  // (Epic #46 follow-up rename: "automationCompletionRate" read like
  // approved/exported products; this is delivery-to-review.)
  const automation = metric(
    divide(agg.completionPool, activeItems),
    'ratio',
    'exact',
    activeItems === 0
      ? 'No active items (all skipped or empty batch)'
      : 'Denominator = total items minus skipped',
  );

  // attentionVolume + attentionRateByReason.
  const reasonBreakdown: MetricBreakdownEntry[] = [...agg.attentionByReason.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => ({ key, value, share: divide(value, agg.attentionCount) }));
  const attention = metric(agg.attentionCount, 'items', 'exact');
  const attentionByReason = metric(
    agg.attentionCount,
    'items',
    'exact',
    'Counts grouped by attentionReason; "unspecified" when no reason is projected',
    reasonBreakdown,
  );

  // attentionResolutionTime: genuinely underivable without entry timestamps.
  const resolutionTime = metric(
    null,
    'hours',
    'not_available',
    'No durable needs_input entry timestamp exists; requires explicit event capture (future phase)',
  );

  // Distributor-only vs official-site completion (epic #46 follow-up
  // rename: "productsCompletedFromDistributorOnly" sounded like promoted
  // products; this is the share of review-ready products that came from the
  // distributor-record path).
  const distributorOnly = metric(
    divide(agg.distributorCompleted, agg.completionPool),
    'ratio',
    'exact',
    'Share of review-ready (automation-finished) items sourced purely from distributor records (no official-site visit)',
  );
  const officialSite = metric(
    divide(agg.officialCompleted, agg.completionPool),
    'ratio',
    'exact',
    'Share of automation-finished items whose selected source is an official manufacturer page',
    [
      { key: 'distributor_record', value: agg.distributorCompleted, share: divide(agg.distributorCompleted, agg.completionPool) },
      { key: 'official_page', value: agg.officialCompleted, share: divide(agg.officialCompleted, agg.completionPool) },
    ],
  );

  // Extractor-profile blocks.
  const profileBlockRate = metric(
    divide(agg.profileBlockCount, agg.attentionCount),
    'ratio',
    'exact',
    agg.attentionCount === 0 ? 'No items need attention' : 'Profile-required + profile-failed attention over all attention',
  );
  const domainUnblockCount = scope === 'global'
    ? metric(countAuditLogsByAction(workspaceId, 'domain_release'), 'operations', 'exact',
      'Count of domain-release audit OPERATIONS (operator-triggered releases after profile setup); items released per operation are not recorded')
    : metric(null, 'operations', 'not_available',
      'Domain-release operations are recorded per workspace/domain, not per batch');

  // Family waits.
  const familiesWaiting = metric(agg.waitingFamilyCount, 'items', 'exact');
  const waitDurations = agg.readyCohortDurationsMs;
  const familyWaitDuration = waitDurations.length > 0
    ? metric(
        waitDurations.reduce((sum, ms) => sum + ms, 0) / waitDurations.length / 3_600_000,
        'hours',
        'approximation',
        `Mean wait across ${waitDurations.length} ready cohort(s); ready time approximated as the cohort's final updated_at`,
      )
    : metric(null, 'hours', 'not_available', 'No cohort has reached the ready state yet');

  // Cohort Curation success.
  const cohortRuns = agg.cohortSuccess + agg.cohortFailure;
  const cohortSuccessRate = cohortRuns > 0
    ? metric(divide(agg.cohortSuccess, cohortRuns), 'ratio', 'exact',
      `Terminal cohort-run outcomes: ${agg.cohortSuccess} success / ${agg.cohortFailure} failed`)
    : metric(null, 'ratio', 'not_available', 'No cohort run has reached a terminal outcome yet');

  // Review.
  const productsReadyForReview = metric(agg.readyForReviewCount, 'items', 'exact');

  let throughput: TelemetryMetric;
  if (agg.earliestBatchStartMs === null) {
    throughput = metric(null, 'products/min', 'not_available', 'No batches in scope');
  } else {
    const elapsedMinutes = Math.max((Date.now() - agg.earliestBatchStartMs) / 60_000, 1 / 60);
    // Approximation, NOT exact (epic #46 fix 6): the elapsed window is
    // "since the batch was CREATED", which includes automation time before
    // anyone starts reviewing — this is a throughput floor, not a measured
    // review rate.
    throughput = metric(
      agg.reviewedCount / elapsedMinutes,
      'products/min',
      'approximation',
      `Reviewed ${agg.reviewedCount} over ${elapsedMinutes.toFixed(1)} min since batch creation (clamped to ≥1s for fresh batches); automation lead time inflates the denominator, so this is a floor, not a measured review rate`,
    );
  }

  const reviewEditRate = metric(
    divide(agg.invalidatedCount, agg.reviewedCount),
    'ratio',
    'approximation',
    'CURRENT invalidated-over-reviewed ratio — a re-review clears the invalidation marker, so historical edits disappear from this ratio; not a historical edit rate',
  );

  // Approval rate (epic #46 follow-up: renamed from bulkApprovalSuccessRate,
  // which read as "bulk approvals failed" when zero attempts existed). With
  // no reviewed items there is no measured rate — not_available, not 0.
  const approvalSuccessRate = agg.reviewedCount > 0
    ? metric(
        divide(agg.approvedCount, agg.reviewedCount),
        'ratio',
        'approximation',
        'Approved over reviewed; rejected-at-attempt items are indistinguishable from still-pending reviewed items in durable state',
      )
    : metric(
        null,
        'ratio',
        'not_available',
        'No items reviewed yet — the rate is undefined until at least one review exists',
      );

  // Export.
  let exportSuccessRate: TelemetryMetric;
  if (scope === 'batch') {
    let pushed = 0;
    let surface = 0;
    for (const status of agg.promotedSkuStatuses.values()) {
      surface += 1;
      if (status === 'pushed') pushed += 1;
    }
    exportSuccessRate = surface > 0
      ? metric(divide(pushed, surface), 'ratio', 'exact',
        `${pushed}/${surface} promoted SKUs verified pushed; in-flight draft/reviewing/approved change-set states are not failures`)
      : metric(null, 'ratio', 'not_available', 'No items have reached promotion yet');
  } else {
    const counts = listChangeSetCountsByState(workspaceId);
    let pushed = 0;
    let surface = 0;
    for (const [state, count] of Object.entries(counts)) {
      if (!CHANGE_SET_ACTIVE_STATES.has(state)) continue;
      surface += Number(count) || 0;
      if (state === 'pushed') pushed = Number(count) || 0;
    }
    exportSuccessRate = surface > 0
      ? metric(divide(pushed, surface), 'ratio', 'exact',
        `${pushed}/${surface} change sets pushed across the workspace; in-flight states are not failures`)
      : metric(null, 'ratio', 'not_available', 'No change sets exist yet');
  }

  // M6 (P2) — strict proof-class / needs-input delta (derived from discovery telemetry if available; otherwise not_available)
  const strictProofClassSelectionRate = metric(null, 'ratio', 'not_available', 'M6 closeout: strict proof-class selection requires discovery proof-class counters sampled over window');
  const needsInputDelta = metric(null, 'count', 'not_available', 'M6 closeout: needs_input delta requires benchmark baseline window');
  const reviewQueueRowRequests = metric(null, 'count', 'not_available', 'M6 closeout: review queue row requests require request logging window');
  const reviewDetailRequests = metric(null, 'count', 'not_available', 'M6 closeout: review detail requests require request logging window');
  const workStateP95Ms = metric(null, 'ms', 'not_available', 'M6 closeout: work-state p95 requires latency histogram window');
  const workStateP99Ms = metric(null, 'ms', 'not_available', 'M6 closeout: work-state p99 requires latency histogram window');
  const workStateStatements = metric(null, 'count', 'not_available', 'M6 closeout: work-state statements require query-count instrumentation window');
  const workStateScannedRows = metric(null, 'count', 'not_available', 'M6 closeout: work-state scanned rows require scan instrumentation window');
  // Projection degradation derived from durable work-state health issues if batch-scoped traversal were available; here report not_available until windowed
  const projectionDegradationCount = metric(null, 'count', 'not_available', 'M6 closeout: projection degradation requires work-state health window');
  // Receipt counts derived from durable receipts when table exists
  let approvalAttempts: TelemetryMetric;
  let approvalReplays: TelemetryMetric;
  let approvalConflicts: TelemetryMetric;
  let approvalInterruptedReceipts: TelemetryMetric;
  let exportDraftAttempts: TelemetryMetric;
  let exportDraftReplays: TelemetryMetric;
  try {
    const db = getDb();
    const baseWhere = scope === 'batch' && batchId ? "workspace_id = ? AND batch_id = ?" : "workspace_id = ?";
    const params: any[] = scope === 'batch' && batchId ? [workspaceId, batchId] : [workspaceId];
    const rows = db.query(`SELECT operation, details_json as detailsJson FROM onboarding_operation_receipts WHERE ${baseWhere}`).all(...params) as Array<{operation:string, detailsJson:string|null}>;
    let aAttempts = rows.filter(r=>r.operation==='approve').length;
    let eAttempts = rows.filter(r=>r.operation==='export').length;
    let aSuccess = 0, aReject = 0, aReplays = 0, aConflicts = 0, aInterrupted = 0;
    let eSuccess = 0, eReject = 0, eConflicts = 0, eInterrupted = 0, eReplays = 0;
    for (const r of rows) {
      if (r.detailsJson === null) {
        if (r.operation === 'approve') aInterrupted += 1;
        else if (r.operation === 'export') eInterrupted += 1;
        continue;
      }
      try {
        const d = JSON.parse(r.detailsJson);
        if (r.operation === 'approve') {
          if (typeof d.approvedCount === 'number') aSuccess += d.approvedCount;
          if (typeof d.rejectedCount === 'number') aReject += d.rejectedCount;
        } else if (r.operation === 'export') {
          if (typeof d.successCount === 'number') eSuccess += d.successCount;
          if (typeof d.rejectedCount === 'number') eReject += d.rejectedCount;
        }
      } catch {}
    }
    approvalAttempts = metric(aAttempts, 'count', 'exact', 'Count of approve receipts (batch-scoped when batchId given)');
    approvalReplays = metric(null, 'count', 'not_available', 'Replays require durable replay marker (not persisted in receipt details)');
    approvalConflicts = metric(null, 'count', 'not_available', 'Conflicts require durable conflict marker (conflict returns directly, not persisted)');
    approvalInterruptedReceipts = metric(aInterrupted, 'count', 'exact', 'Interrupted approve receipts (null details_json)');
    exportDraftAttempts = metric(eAttempts, 'count', 'exact', 'Count of export receipts');
    exportDraftReplays = metric(null, 'count', 'not_available', 'Export replays require durable replay marker (not persisted)');
    // Also expose success/reject/conflict/interrupted for export/approval
    var approvalSuccessCount = metric(aSuccess, 'count', 'exact', 'Approved items');
    var approvalRejectCount = metric(aReject, 'count', 'exact', 'Rejected items');
    var exportSuccessCount = metric(eSuccess, 'count', 'exact', 'Export success');
    var exportRejectCount = metric(eReject, 'count', 'exact', 'Export reject');
    var exportConflictCount = metric(null, 'count', 'not_available', 'Export conflicts require durable marker');
    var exportInterruptedCount = metric(eInterrupted, 'count', 'exact', 'Export interrupted (null details_json)');
  } catch {
    approvalAttempts = metric(null, 'count', 'not_available', 'Receipt table unavailable');
    approvalReplays = metric(null, 'count', 'not_available', 'Receipt table unavailable');
    approvalConflicts = metric(null, 'count', 'not_available', 'Receipt table unavailable');
    approvalInterruptedReceipts = metric(null, 'count', 'not_available', 'Receipt table unavailable');
    exportDraftAttempts = metric(null, 'count', 'not_available', 'Receipt table unavailable');
    exportDraftReplays = metric(null, 'count', 'not_available', 'Receipt table unavailable');
    var approvalSuccessCount = metric(null, 'count', 'not_available', 'Receipt table unavailable');
    var approvalRejectCount = metric(null, 'count', 'not_available', 'Receipt table unavailable');
    var exportSuccessCount = metric(null, 'count', 'not_available', 'Receipt table unavailable');
    var exportRejectCount = metric(null, 'count', 'not_available', 'Receipt table unavailable');
    var exportConflictCount = metric(null, 'count', 'not_available', 'Receipt table unavailable');
    var exportInterruptedCount = metric(null, 'count', 'not_available', 'Receipt table unavailable');
  }
  let importNormalizationCounts: TelemetryMetric;
  let lossyLegacyRows: TelemetryMetric;
  try {
    const db = getDb();
    const scopeWhere = scope === 'batch' && batchId ? "batch_id = ?" : "batch_id IN (SELECT id FROM onboarding_batches WHERE workspace_id = ?)";
    const normParams: any[] = scope === 'batch' && batchId ? [batchId] : [workspaceId];
    // Aggregate bounded transformations[].code from validated normalized envelopes
    const rows = db.query(`SELECT normalized_identity_json as normJson FROM onboarding_items WHERE ${scopeWhere} AND normalized_identity_json IS NOT NULL`).all(...normParams) as Array<{normJson:string}>;
    const codeCounts = new Map<string, number>();
    for (const r of rows) {
      try {
        const env = JSON.parse(r.normJson);
        const trans = Array.isArray(env.transformations) ? env.transformations : [];
        for (const tr of trans) {
          if (tr && typeof tr.code === 'string') {
            const c = tr.code;
            codeCounts.set(c, (codeCounts.get(c) ?? 0) + 1);
          }
        }
      } catch {}
    }
    const breakdown = [...codeCounts.entries()].map(([k,v])=>({key:k, value:v, share: null})).sort((a,b)=>b.value-a.value);
    const totalTransformations = [...codeCounts.values()].reduce((sum, n) => sum + n, 0);
    importNormalizationCounts = { value: totalTransformations, unit: 'count', derivation: 'exact', note: 'Bounded counts by transformation code (split_glued_size, move_trailing_brand) — headline is total transformations, not rows', breakdown };
    const lossyWhere = scope === 'batch' && batchId ? "batch_id = ? AND (raw_identity_json IS NULL OR identity_provenance_hash IS NULL)" : "batch_id IN (SELECT id FROM onboarding_batches WHERE workspace_id = ?) AND (raw_identity_json IS NULL OR identity_provenance_hash IS NULL)";
    const lossy = db.query(`SELECT COUNT(*) as cnt FROM onboarding_items WHERE ${lossyWhere}`).get(...normParams) as {cnt:number}|undefined;
    lossyLegacyRows = metric(lossy ? Number(lossy.cnt) : 0, 'count', 'exact', 'Rows without raw identity or provenance hash (lossy legacy)');
  } catch {
    importNormalizationCounts = metric(null, 'count', 'not_available', 'Identity columns unavailable');
    lossyLegacyRows = metric(null, 'count', 'not_available', 'Identity columns unavailable');
  }

  // Derive review queue payload/latency from available instrumentation if present, else not_available honestly
  const reviewQueuePayloadSize = metric(null, 'bytes', 'not_available', 'Review queue payload requires request-size instrumentation window');
  const reviewQueueLoadLatencyMs = metric(null, 'ms', 'not_available', 'Review queue load latency requires timing histogram window');
  // Ensure newly added approval/export detailed counts are available via earlier var hoisting (may be null if receipt table unavailable)
  // Provide fallbacks if var not set due to scope
  const _approvalSuccessCount = typeof approvalSuccessCount !== 'undefined' ? approvalSuccessCount : metric(null, 'count', 'not_available', 'Receipt table unavailable');
  const _approvalRejectCount = typeof approvalRejectCount !== 'undefined' ? approvalRejectCount : metric(null, 'count', 'not_available', 'Receipt table unavailable');
  const _exportSuccessCount = typeof exportSuccessCount !== 'undefined' ? exportSuccessCount : metric(null, 'count', 'not_available', 'Receipt table unavailable');
  const _exportRejectCount = typeof exportRejectCount !== 'undefined' ? exportRejectCount : metric(null, 'count', 'not_available', 'Receipt table unavailable');
  const _exportConflictCount = typeof exportConflictCount !== 'undefined' ? exportConflictCount : metric(null, 'count', 'not_available', 'Receipt table unavailable');
  const _exportInterruptedCount = typeof exportInterruptedCount !== 'undefined' ? exportInterruptedCount : metric(null, 'count', 'not_available', 'Receipt table unavailable');
  const _exportInterruptedReceipts = typeof exportInterruptedCount !== 'undefined' ? exportInterruptedCount : metric(null, 'count', 'not_available', 'Receipt table unavailable');
  return {
    automationToReviewRate: automation,
    attentionVolume: attention,
    attentionRateByReason: attentionByReason,
    attentionResolutionTime: resolutionTime,
    distributorRecordShareOfReviewReady: distributorOnly,
    productsRequiringOfficialSite: officialSite,
    extractorProfileBlockRate: profileBlockRate,
    extractorProfileDomainUnblockCount: domainUnblockCount,
    familiesWaitingCount: familiesWaiting,
    familyWaitDurationHours: familyWaitDuration,
    cohortCurationSuccessRate: cohortSuccessRate,
    productsReadyForReview: productsReadyForReview,
    reviewThroughputProductsPerMinute: throughput,
    reviewEditRate: reviewEditRate,
    approvalRate: approvalSuccessRate,
    exportSuccessRate: exportSuccessRate,
    strictProofClassSelectionRate,
    needsInputDelta,
    reviewQueueRowRequests,
    reviewDetailRequests,
    reviewQueuePayloadSize,
    reviewQueueLoadLatencyMs,
    workStateP95Ms,
    workStateP99Ms,
    workStateStatements,
    workStateScannedRows,
    projectionDegradationCount,
    approvalAttempts,
    approvalSuccessCount: _approvalSuccessCount,
    approvalRejectCount: _approvalRejectCount,
    approvalReplays,
    approvalConflicts,
    approvalInterruptedReceipts,
    exportDraftAttempts,
    exportSuccessCount: _exportSuccessCount,
    exportRejectCount: _exportRejectCount,
    exportConflictCount: _exportConflictCount,
    exportInterruptedCount: _exportInterruptedCount,
    exportDraftReplays,
    exportInterruptedReceipts: _exportInterruptedReceipts,
    importNormalizationCounts,
    lossyLegacyRows,
  };
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute the operator-facing onboarding metrics for a batch (when
 * `batchId` is given) or the whole workspace.
 */
export function getOnboardingMetrics(input: OnboardingMetricsInput): OnboardingTelemetry {
  const scope = input.batchId ? 'batch' : 'global';
  const slices: BatchSlice[] = [];

  if (input.batchId) {
    const batch = findBatchById(input.batchId);
    if (!batch || batch.workspaceId !== input.workspaceId) {
      throw new Error(`Batch ${input.batchId} not found in workspace`);
    }
    slices.push(loadBatchSlice(input.batchId, Date.now()));
  } else {
    const nowMs = Date.now();
    for (const batch of listBatches(input.workspaceId)) {
      slices.push(loadBatchSlice(batch.id, nowMs));
    }
  }

  const agg = aggregateBatch(slices, input.workspaceId);
  const metrics = buildMetrics(agg, input.workspaceId, scope, input.batchId ?? null);

  return {
    scope,
    batchId: input.batchId ?? null,
    generatedAt: new Date().toISOString(),
    metrics,
  };
}