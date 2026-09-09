// ---------------------------------------------------------------------------
// Manager Inbox deterministic collectors (operations console, Issue 3)
//
// Every collector derives authoritative candidate facts from repository/
// service reads only — no model, no network, no onboarding mutation. Each
// candidate carries a stable dedupe key ({kind}:{sourceKey}:v{ruleVersion})
// and a content fingerprint so reconciliation can upsert, resolve
// disappeared findings, and re-open changed ones.
//
// Vocabulary guardrails: "Curation batch stalled" is display shorthand. The
// stored scope identifies Onboarding Items in the Curation stage with stale
// `in_progress` or `failed` Stage Status plus their Onboarding Batch lens.
// No batch lifecycle status is invented or controlled here.
// ---------------------------------------------------------------------------

import { getCatalogHealthReport } from '../services/product-service';
import { hashCanonicalJson } from '../../shared/stable-id';
import { getProposalReviewSummary } from '../../db/repositories/catalog-health-proposal-repo';
import { listFailedSyncJobs } from '../../db/repositories/sync-job-repo';
import { listChangeSetsNeedingImageRepair } from '../../db/repositories/change-set-repo';
import { listBatches } from '../../db/repositories/onboarding-batch-repo';
import { listItemsByBatchStaged } from '../../db/repositories/onboarding-item-repo';
import { listSchedules, listRecentFailedOccurrences } from '../../db/repositories/store-manager-schedule-repo';
import type {
  StoreManagerInboxKind,
  StoreManagerInboxScope,
  StoreManagerInboxSourceRef,
  StoreManagerSeverity,
} from '../../shared/schemas/store-manager-inbox';

/** How old an in-progress/failed Curation item must be to count as stalled. */
export const CURATION_STALL_MS = 24 * 60 * 60 * 1000;

/** Per-kind collector rule version (bump → new dedupe keys → fresh rows). */
const COLLECTOR_RULE_VERSION: Record<StoreManagerInboxKind, number> = {
  high_severity_catalog_issues: 1,
  proposals_awaiting_review: 1,
  failed_sync_jobs: 1,
  image_repairs_recommended: 1,
  curation_stalled: 1,
  scheduled_run_failed: 1,
};

export interface InboxCollectorContext {
  /** Injected clock (tests). */
  now?: () => Date;
  /** Stale threshold for Curation items (tests). */
  curationStallMs?: number;
  /** Bounded per-kind source-reference caps. */
  maxSourceRefs?: number;
  /** Recent-failure window for scheduled-run failures (tests). */
  scheduleFailureWindowMs?: number;
}

export interface InboxCandidate {
  workspaceId: string;
  kind: StoreManagerInboxKind;
  dedupeKey: string;
  severity: StoreManagerSeverity;
  title: string;
  summary: string;
  scope: StoreManagerInboxScope;
  count: number;
  sourceRefs: StoreManagerInboxSourceRef[];
  fingerprint: string;
  sourceUpdatedAt: string;
}

function nowIso(now?: () => Date): string {
  return (now?.() ?? new Date()).toISOString();
}

function fingerprintFor(
  kind: StoreManagerInboxKind,
  sourceKey: string,
  ruleVersion: number,
  count: number,
  severity: StoreManagerSeverity,
): string {
  return hashCanonicalJson({ kind, sourceKey, ruleVersion, count, severity });
}

function dedupeKeyFor(kind: StoreManagerInboxKind, sourceKey: string): string {
  return `${kind}:${sourceKey}:v${COLLECTOR_RULE_VERSION[kind]}`;
}

// ---------------------------------------------------------------------------
// Collector 1: high-severity catalog issues
// ---------------------------------------------------------------------------

function collectHighSeverityCatalogIssues(workspaceId: string, ctx: InboxCollectorContext): InboxCandidate[] {
  const health = getCatalogHealthReport();
  const blockers = health.issues.filter((i) => i.severity === 'blocker');
  if (blockers.length === 0) return [];
  const distinctSkus = new Set(blockers.map((i) => i.sku)).size;
  const maxRefs = ctx.maxSourceRefs ?? 50;
  const sourceRefs = blockers
    .slice(0, maxRefs)
    .map((i) => ({ kind: 'validation_result' as const, id: `${i.code}:${i.sku}`.slice(0, 200) }));
  return [
    {
      workspaceId,
      kind: 'high_severity_catalog_issues',
      dedupeKey: dedupeKeyFor('high_severity_catalog_issues', 'catalog'),
      severity: 'critical',
      title: 'High-severity catalog issues',
      summary: `${blockers.length} blocker issue(s) across ${distinctSkus} product(s).`,
      scope: { kind: 'catalog' },
      count: blockers.length,
      sourceRefs,
      fingerprint: fingerprintFor('high_severity_catalog_issues', 'catalog', COLLECTOR_RULE_VERSION.high_severity_catalog_issues, blockers.length, 'critical'),
      sourceUpdatedAt: nowIso(ctx.now),
    },
  ];
}

// ---------------------------------------------------------------------------
// Collector 2: proposals awaiting review
// ---------------------------------------------------------------------------

function collectProposalsAwaitingReview(workspaceId: string, ctx: InboxCollectorContext): InboxCandidate[] {
  const { count, samples } = getProposalReviewSummary(workspaceId, 10);
  if (count === 0) return [];
  const maxRefs = ctx.maxSourceRefs ?? 50;
  return [
    {
      workspaceId,
      kind: 'proposals_awaiting_review',
      dedupeKey: dedupeKeyFor('proposals_awaiting_review', 'catalog'),
      severity: 'info',
      title: 'Proposals awaiting review',
      summary: `${count} catalog-health proposal(s) waiting for review.`,
      scope: { kind: 'catalog' },
      count,
      sourceRefs: samples.slice(0, maxRefs).map((s) => ({ kind: 'proposal', id: s.id })),
      fingerprint: fingerprintFor('proposals_awaiting_review', 'catalog', COLLECTOR_RULE_VERSION.proposals_awaiting_review, count, 'info'),
      sourceUpdatedAt: samples[0]?.createdAt ?? nowIso(ctx.now),
    },
  ];
}

// ---------------------------------------------------------------------------
// Collector 3: failed sync jobs
// ---------------------------------------------------------------------------

function collectFailedSyncJobs(workspaceId: string, ctx: InboxCollectorContext): InboxCandidate[] {
  const jobs = listFailedSyncJobs(workspaceId, 50);
  if (jobs.length === 0) return [];
  const maxRefs = ctx.maxSourceRefs ?? 50;
  const latest = jobs.reduce((m, j) => (j.completedAt && j.completedAt > m ? j.completedAt : m), jobs[0].completedAt ?? nowIso(ctx.now));
  return [
    {
      workspaceId,
      kind: 'failed_sync_jobs',
      dedupeKey: dedupeKeyFor('failed_sync_jobs', 'sync'),
      severity: 'critical',
      title: 'Failed sync jobs',
      summary: `${jobs.length} sync job(s) failed.`,
      scope: { kind: 'catalog' },
      count: jobs.length,
      sourceRefs: jobs.slice(0, maxRefs).map((j) => ({ kind: 'sync_job', id: j.id })),
      fingerprint: fingerprintFor('failed_sync_jobs', 'sync', COLLECTOR_RULE_VERSION.failed_sync_jobs, jobs.length, 'critical'),
      sourceUpdatedAt: latest,
    },
  ];
}

// ---------------------------------------------------------------------------
// Collector 4: image repairs recommended (static local-reference analysis)
// ---------------------------------------------------------------------------

function collectImageRepairsRecommended(workspaceId: string, ctx: InboxCollectorContext): InboxCandidate[] {
  const recs = listChangeSetsNeedingImageRepair(workspaceId, 20);
  if (recs.length === 0) return [];
  const maxRefs = ctx.maxSourceRefs ?? 20;
  return recs.map((r) => {
    const sourceKey = `change_set:${r.changeSetId}`;
    return {
      workspaceId,
      kind: 'image_repairs_recommended',
      dedupeKey: dedupeKeyFor('image_repairs_recommended', sourceKey),
      severity: 'warning',
      title: `Image repairs recommended — ${r.changeSetTitle.slice(0, 80) || 'Change Set'}`,
      summary: `${r.itemCount} item(s) reference local image paths in Change Set ${r.changeSetId.slice(0, 8)} (status ${r.changeSetStatus}).`,
      scope: { kind: 'change_set', changeSetId: r.changeSetId },
      count: r.itemCount,
      sourceRefs: r.sampleSkus.slice(0, maxRefs).map((sku) => ({ kind: 'sku', id: sku })),
      fingerprint: fingerprintFor('image_repairs_recommended', sourceKey, COLLECTOR_RULE_VERSION.image_repairs_recommended, r.itemCount, 'warning'),
      sourceUpdatedAt: r.updatedAt,
    };
  });
}

// ---------------------------------------------------------------------------
// Collector 5: stalled Curation items (Onboarding Items in Curation whose
// Stage Status is stale `in_progress`/`failed`; Onboarding Batch is lens only)
// ---------------------------------------------------------------------------

function collectCurationStalled(workspaceId: string, ctx: InboxCollectorContext): InboxCandidate[] {
  const now = ctx.now?.() ?? new Date();
  const stallMs = ctx.curationStallMs ?? CURATION_STALL_MS;
  const staleBeforeIso = new Date(now.getTime() - stallMs).toISOString();
  const maxRefs = ctx.maxSourceRefs ?? 50;
  const candidates: InboxCandidate[] = [];
  for (const batch of listBatches(workspaceId)) {
    // Slice 5b native: staged grouping is canonical v2-keyed.
    const curationItems = listItemsByBatchStaged(batch.id).prepare_listing;
    const stale = curationItems.filter(
      (item) =>
        (item.stageStatus === 'in_progress' || item.stageStatus === 'failed') &&
        item.updatedAt < staleBeforeIso,
    );
    if (stale.length === 0) continue;
    const statuses = [...new Set(stale.map((i) => i.stageStatus))].sort().join('/');
    const latestUpdated = stale.reduce((m, i) => (i.updatedAt > m ? i.updatedAt : m), stale[0].updatedAt);
    const sourceKey = `batch:${batch.id}`;
    candidates.push({
      workspaceId,
      kind: 'curation_stalled',
      dedupeKey: dedupeKeyFor('curation_stalled', sourceKey),
      severity: 'warning',
      title: `Curation stalled — ${batch.name.slice(0, 80)}`,
      summary: `${stale.length} Curation item(s) stalled (${statuses}) since ${latestUpdated.slice(0, 10)}.`,
      scope: { kind: 'onboarding_batch', batchId: batch.id },
      count: stale.length,
      sourceRefs: stale.slice(0, maxRefs).map((i) => ({ kind: 'onboarding_item', id: i.id })),
      fingerprint: fingerprintFor('curation_stalled', sourceKey, COLLECTOR_RULE_VERSION.curation_stalled, stale.length, 'warning'),
      sourceUpdatedAt: latestUpdated,
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Collector 6: failed scheduled runs (Issue 4 — deduped operational item).
// Derives from recent failed/unavailable schedule occurrences; the item
// disappears (and reconcile resolves it) when the source recovers.
// ---------------------------------------------------------------------------

function collectScheduledRunFailures(workspaceId: string, ctx: InboxCollectorContext): InboxCandidate[] {
  const windowMs = ctx.scheduleFailureWindowMs ?? 7 * 24 * 60 * 60 * 1000;
  const sinceIso = new Date((ctx.now?.() ?? new Date()).getTime() - windowMs).toISOString();
  const occurrences = listRecentFailedOccurrences(workspaceId, sinceIso, 50);
  const bySchedule = new Map<string, { count: number; latestErrorCode: string; latestAt: string; occurrences: Array<{ id: string }> }>();
  for (const occ of occurrences) {
    const entry = bySchedule.get(occ.scheduleId) ?? { count: 0, latestErrorCode: occ.errorCode ?? 'unknown', latestAt: occ.completedAt ?? occ.updatedAt, occurrences: [] };
    entry.count += 1;
    entry.occurrences.push({ id: occ.id });
    if ((occ.completedAt ?? occ.updatedAt) > entry.latestAt) {
      entry.latestAt = occ.completedAt ?? occ.updatedAt;
      entry.latestErrorCode = occ.errorCode ?? 'unknown';
    }
    bySchedule.set(occ.scheduleId, entry);
  }
  const maxRefs = ctx.maxSourceRefs ?? 20;
  const candidates: InboxCandidate[] = [];
  for (const schedule of listSchedules(workspaceId, 100)) {
    const entry = bySchedule.get(schedule.id);
    if (!entry) continue;
    candidates.push({
      workspaceId,
      kind: 'scheduled_run_failed',
      dedupeKey: dedupeKeyFor('scheduled_run_failed', `schedule:${schedule.id}`),
      severity: 'warning',
      title: `Scheduled run failing — ${schedule.name.slice(0, 80)}`,
      summary: `${entry.count} recent failed run(s) (${entry.latestErrorCode}). Review occurrence history before re-enabling.`,
      scope: { kind: 'catalog' },
      count: entry.count,
      sourceRefs: [
        { kind: 'schedule', id: schedule.id },
        ...entry.occurrences.slice(0, maxRefs).map((o) => ({ kind: 'schedule_occurrence', id: o.id })),
      ],
      fingerprint: fingerprintFor('scheduled_run_failed', `schedule:${schedule.id}`, COLLECTOR_RULE_VERSION.scheduled_run_failed, entry.count, 'warning'),
      sourceUpdatedAt: entry.latestAt,
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Combined collection
// ---------------------------------------------------------------------------

/**
 * Collect every deterministic candidate for one workspace. Order is stable
 * (kind, then source key) so reconciliation is deterministic across scans.
 * The total candidate set is bounded.
 */
export function collectInboxCandidates(workspaceId: string, ctx: InboxCollectorContext = {}): InboxCandidate[] {
  const parts: InboxCandidate[][] = [
    collectHighSeverityCatalogIssues(workspaceId, ctx),
    collectProposalsAwaitingReview(workspaceId, ctx),
    collectFailedSyncJobs(workspaceId, ctx),
    collectImageRepairsRecommended(workspaceId, ctx),
    collectCurationStalled(workspaceId, ctx),
    collectScheduledRunFailures(workspaceId, ctx),
  ];
  return parts
    .flat()
    .sort((a, b) => (a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0))
    .slice(0, 200);
}
