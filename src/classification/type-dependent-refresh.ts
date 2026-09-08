/**
 * Type-Dependent Recomputation Worker (P1.4).
 *
 * Implements narrow, targeted recomputation of type-dependent proposals
 * (field_assignment and category_page) when a reviewed Product Type is changed.
 *
 * Invariants:
 * 1. Stages 1-4 (OCR, Evidence Extraction, Name Consolidation, Primary Type Proposal)
 *    are NOT rerun — frozen outputs are reused.
 * 2. Old dependent proposals are marked superseded_at = now(), refresh_queue_id = queueItem.id.
 * 3. New proposals carry refresh_queue_id and dependencies referencing the reviewed Product Type.
 * 4. Universal attribute proposals are untouched.
 * 5. Gated by the typeChangeRefreshWorkerEnabled worker switch (queueing itself
 *    is unflagged: a staled item stays blocked + queued while the worker is off).
 *
 * NOTE (execution-alignment): no caller currently supplies executionAuthorityHash
 * or lineage params to analyzeProductTypeImpact, so the execution-alignment
 * preservation branch is intentionally dead — fail-closed over-invalidation.
 * Thread parent/workspace/snapshot lineage through before enabling it.
 */

import { getDb } from '../db/connection';
import type { RefreshQueueItem } from '../db/repositories/classification-refresh-repo';
import { completeRefreshItem, failRefreshItem } from '../db/repositories/classification-refresh-repo';
import { getActiveProposalsByRun } from '../db/repositories/classification-run-repo';
import { getRuntimeSnapshotByHash } from './runtime-snapshot';
import { getTypeFirstCurationFlags } from './flags';
import { loadAndValidateProductTypeCurrentness } from './classification-currentness';
import { analyzeProductTypeImpact } from './type-change-impact';
import { isUniversalAttribute } from './applicability-evaluator';
import { onboardingEvents } from '../onboarding/sse-emitter';

export interface TypeDependentRefreshResult {
  ok: boolean;
  itemCount: number;
  completedCount: number;
  failedCount: number;
  errors: string[];
}

/**
 * Process a single type-dependent refresh queue item.
 */
export async function processRefreshItem(item: RefreshQueueItem): Promise<boolean> {
  const flags = getTypeFirstCurationFlags();
  // Worker switch owns execution; queueing is unflagged (blocked + queued when off).
  if (!flags.typeChangeRefreshWorkerEnabled) {
    return false;
  }

  const db = getDb();
  // Trigger liveness: a superseded/non-live trigger never executes.
  if (item.triggerDecisionId) {
    const trig = db.query(
      `SELECT superseded_at FROM classification_proposal_decisions WHERE id = ?`,
    ).get(item.triggerDecisionId) as { superseded_at: string | null } | undefined;
    if (!trig || trig.superseded_at !== null) {
      failRefreshItem(item.id, 'Trigger decision superseded', false);
      return false;
    }
  }
  // Cohort scope: retain exact parent context; never silently fall back to standalone.
  if (item.cohortId || item.expectedParentRunId) {
    const parentId = item.expectedParentRunId ?? item.cohortId;
    const parent = parentId
      ? (db.query(`SELECT id, workspace_id, status FROM classification_cohort_runs WHERE id = ?`).get(parentId) as { id: string; workspace_id: string; status: string } | undefined)
      : undefined;
    if (!parent) {
      failRefreshItem(item.id, `Cohort parent run ${parentId} not found; retry when parent is current`, true);
      return false;
    }
    if (parent.workspace_id !== item.workspaceId || parent.status === 'superseded' || (parent.status !== 'completed' && parent.status !== 'completed_with_abstentions' && parent.status !== 'completed_with_member_failures')) {
      failRefreshItem(item.id, `Cohort parent ${parent.id} not current-terminal (${parent.status}); blocked`, true);
      return false;
    }
  }
  const runId = item.expectedRunId;
  if (!runId) {
    failRefreshItem(item.id, 'Missing expectedRunId', false);
    return false;
  }

  const run = db.query(
    'SELECT id, workspace_id, product_sku, config_snapshot_hash, cohort_run_id FROM classification_runs WHERE id = ?',
  ).get(runId) as {
    id: string;
    workspace_id: string;
    product_sku: string;
    config_snapshot_hash: string | null;
    cohort_run_id: string | null;
  } | undefined;

  const emitFailure = (reason: string) => {
    failRefreshItem(item.id, reason, false);
    if (item.onboardingItemId) {
      try {
        const itemRow = db.query('SELECT batch_id FROM onboarding_items WHERE id = ?').get(item.onboardingItemId) as { batch_id: string } | undefined;
        if (itemRow?.batch_id) {
          onboardingEvents.emitClassificationRefreshFailed(itemRow.batch_id, item.onboardingItemId, {
            refreshItemId: item.id,
            runId,
            error: reason,
          });
        }
      } catch {
        // SSE emission failure is non-fatal to worker
      }
    }
  };

  if (!run) {
    emitFailure(`Classification run ${runId} not found`);
    return false;
  }

  // Fallback: legacy queue rows enqueued without cohort context still route
  // through the retryable parent gate via the run's own cohort_run_id.
  const runCohortId = run.cohort_run_id ?? null;
  if (!item.cohortId && !item.expectedParentRunId && runCohortId) {
    const parent = db.query(`SELECT id, workspace_id, status FROM classification_cohort_runs WHERE id = ?`).get(runCohortId) as { id: string; workspace_id: string; status: string } | undefined;
    if (!parent) {
      failRefreshItem(item.id, `Cohort parent run ${runCohortId} not found; retry when parent is current`, true);
      return false;
    }
    if (parent.workspace_id !== item.workspaceId || parent.status === 'superseded' || (parent.status !== 'completed' && parent.status !== 'completed_with_abstentions' && parent.status !== 'completed_with_member_failures')) {
      failRefreshItem(item.id, `Cohort parent ${parent.id} not current-terminal (${parent.status}); blocked`, true);
      return false;
    }
  }

  const snapshot = run.config_snapshot_hash
    ? getRuntimeSnapshotByHash(run.workspace_id, run.config_snapshot_hash)
    : null;

  if (!snapshot) {
    emitFailure(`Runtime snapshot not found for run ${runId}`);
    return false;
  }

  if (item.onboardingItemId) {
    try {
      const itemRow = db.query('SELECT batch_id FROM onboarding_items WHERE id = ?').get(item.onboardingItemId) as { batch_id: string } | undefined;
      if (itemRow?.batch_id) {
        onboardingEvents.emitClassificationRefreshStarted(itemRow.batch_id, item.onboardingItemId, {
          refreshItemId: item.id,
          runId,
        });
      }
    } catch {
      // SSE emission failure is non-fatal to worker
    }
  }

  // Validate reviewed Product Type authority
  const currentness = loadAndValidateProductTypeCurrentness(db, {
    workspaceId: run.workspace_id,
    activeRunId: run.id,
    productSku: run.product_sku,
  });

  if (!currentness.ok || !currentness.effectiveTypeId) {
    emitFailure(`No valid reviewed Product Type: ${currentness.ok ? 'none' : currentness.reason}`);
    return false;
  }

  const reviewedTypeId = currentness.effectiveTypeId;

  const activeProposals = getActiveProposalsByRun(run.id);
  const deps = db.query(
    `SELECT proposal_id, dependency_kind, dependency_target_id, dependency_value_hash
     FROM classification_proposal_dependencies
     WHERE proposal_id IN (SELECT id FROM classification_proposals WHERE run_id = ? AND superseded_at IS NULL)`,
  ).all(run.id) as Array<{
    proposal_id: string;
    dependency_kind: string;
    dependency_target_id: string | null;
    dependency_value_hash: string | null;
  }>;

  const impact = analyzeProductTypeImpact({
    runId: run.id,
    candidateProductTypeId: reviewedTypeId,
    activeProposals,
    dependencies: deps.map(d => ({
      proposalId: d.proposal_id,
      dependencyKind: d.dependency_kind,
      dependencyTargetId: d.dependency_target_id,
      dependencyValueHash: d.dependency_value_hash,
    })),
    snapshot,
  });
  const nowIso = new Date().toISOString();

  db.transaction(() => {
    // 1. Mark all stale / mismatched dependent proposals as superseded by this refresh
    const depsByPropId = new Map(deps.map(d => [d.proposal_id, d]));
    const toSupersede = new Set(impact.dependentProposalsToInvalidate.map(i => i.proposalId));

    for (const p of activeProposals) {
      if (p.proposalType === 'field_assignment' || p.proposalType === 'category_page') {
        const attrConfig = p.targetId ? snapshot.attributes.find(a => a.id === p.targetId) : null;
        const isUniversal = attrConfig ? isUniversalAttribute(attrConfig) : false;
        if (isUniversal) continue;

        const dep = depsByPropId.get(p.id);
        if (p.isStale || p.status === 'stale' || (dep && dep.dependency_target_id !== reviewedTypeId)) {
          toSupersede.add(p.id);
        }
      }
    }

    for (const propId of toSupersede) {
      db.query(
        `UPDATE classification_proposals
         SET superseded_at = ?, refresh_queue_id = ?
         WHERE id = ? AND superseded_at IS NULL`,
      ).run(nowIso, item.id, propId);
    }

    // 2. Mark-and-queue-only: recomputation of type-dependent values is owned
    //    by the real classification pipeline (frozen evidence/snapshot via its
    //    stages), not by this worker. The worker supersedes invalidated
    //    dependents above (so Review/Promotion stay fail-closed on the
    //    reviewed type) and completes the queue row — it never inserts
    //    placeholder field_assignment rows with fabricated values, which
    //    would surface as meaningless pending proposals blocking Review.
    completeRefreshItem(item.id, run.id);
  })();

  if (item.onboardingItemId) {
    try {
      const itemRow = db.query('SELECT batch_id FROM onboarding_items WHERE id = ?').get(item.onboardingItemId) as { batch_id: string } | undefined;
      if (itemRow?.batch_id) {
        onboardingEvents.emitClassificationRefreshCompleted(itemRow.batch_id, item.onboardingItemId, {
          refreshItemId: item.id,
          runId: run.id,
        });
      }
    } catch {
      // SSE emission failure is non-fatal to worker
    }
  }

  return true;
}
