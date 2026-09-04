/**
 * Epic #46 — operator work-state routes (Phases 1/7/8, Milestone 3 / P1-E).
 *
 * - `GET  /api/onboarding/batches/:id/work-state` — Batch Workspace
 *   projection (counts + paginated items, server-owned derivation) [deprecated, kept for compat].
 * - `GET  /api/onboarding/batches/:id/work-state/counts` — bounded counts + projectionHealth.
 * - `GET  /api/onboarding/batches/:id/work-state/items?cursor&limit` — cursor-paginated items + projectionHealth.
 * - `GET  /api/onboarding/items/:id/work-state` — single-item projection.
 * - `POST /api/onboarding/batches/:id/approve` — bulk approval of reviewed
 *   items (per-item structured outcomes; approval NEVER exports).
 * - `POST /api/onboarding/domains/:domain/release` — deterministic
 *   domain-level release: after an extractor profile becomes usable, blocked
 *   extraction items on that domain are re-queued automatically.
 */
import { Hono } from 'hono';
import { findWorkspace } from '../../db/repositories/workspace-repo';
import { findBatchById } from '../../db/repositories/onboarding-batch-repo';
import {
  findItemById,
} from '../../db/repositories/onboarding-item-repo';
import {
  getBatchWorkState,
  getBatchWorkStateCountsWithHealth,
  getBatchWorkStateItems,
  getItemWorkState,
  type WorkStateFilters,
} from '../../onboarding/onboarding-work-state';
import { WorkStateCursorError } from '../../shared/schemas/onboarding-work-state';
import { WorkStateProjectionError } from '../../db/repositories/onboarding-work-state-repo';
import { buildProjectionHealth } from '../../onboarding/onboarding-work-state';
import { getBatchReviewQueue } from '../../onboarding/onboarding-review-queue';
import {
  ReviewQueueCursorError,
  ReviewQueueFiltersSchema,
} from '../../shared/schemas/onboarding-review-queue';
import { getReviewState, approveAndAdvanceItems, createExportDraftsWithReceipt } from '../../db/repositories/onboarding-review-repo';
import { findByScopedIdempotencyKey, computeRequestHash } from '../../db/repositories/onboarding-operation-receipt-repo';
import { derivePrincipal, derivePrincipalForOperation } from '../authenticated-principal';
import { onboardingEvents } from '../../onboarding/sse-emitter';
import { validateReviewCompletionGate } from '../../classification/review-completion-gate';
import { addAuditLog } from '../../db/repositories/audit-log-repo';
import { releaseDomainExtractionItems } from '../../onboarding/domain-release';
import { getOnboardingMetrics } from '../../onboarding/onboarding-telemetry';
import { getExtractorProfileDomainBlockers } from '../../onboarding/extraction/profile-blockers';
import { verifyDistributorImageryForBatch } from '../../onboarding/distributor-imagery';
import { getWorker } from './onboarding-routes';
import {
  ApproveItemsRequestSchema,
  WorkStateCategoryEnum,
  ReviewStateEnum,
} from '../../shared/schemas/onboarding-work-state';
import { SourceTypeEnum, SubmitManualEvidenceRequestSchema } from '../../shared/schemas/onboarding';
import { getActiveManualEvidenceAttestationForItem } from '../../db/repositories/onboarding-manual-evidence-repo';

const route = new Hono();

// ── Worker poll trigger (test seam) ────────────────────────────────────────────
// The domain-release route kicks the background worker after re-queueing so
// released items are picked up immediately. Unit tests replace the trigger
// with a no-op (a real poll would claim released extraction items and hit the
// extraction worker). Mirrors the codebase's existing test seams (e.g.
// `hooks.afterMemberPipeline` in cohort-curator).
type WorkerPollTrigger = (workspaceId: string, workspacePath: string) => void;
let triggerWorkerPoll: WorkerPollTrigger = (workspaceId, workspacePath) => {
  try {
    getWorker(workspaceId, workspacePath).poll();
  } catch (pollErr) {
    // Background poll failure must never fail the endpoint that triggered it.
    console.error('[OnboardingWorkRoutes] Background worker poll failed (non-blocking):', pollErr);
  }
};

/** Replace the background worker-poll trigger (null restores the no-op). */
export function setWorkerPollTriggerForTest(trigger: WorkerPollTrigger | null): void {
  triggerWorkerPoll = trigger ?? (() => {});
}

/**
 * Parse optional work-state query filters from a Hono request. Invalid enum
 * values fail closed (treated as absent) — never a 500.
 */
function parseWorkStateFilters(c: { req: { query: (key: string) => string | undefined } }): WorkStateFilters {
  const categoryRaw = c.req.query('category');
  const reviewStateRaw = c.req.query('reviewState');
  const sourceTypeRaw = c.req.query('sourceType');
  const limitRaw = c.req.query('limit');
  const offsetRaw = c.req.query('offset');
  const cursorRaw = c.req.query('cursor');

  const filters: WorkStateFilters = {};
  if (categoryRaw) {
    const parsed = WorkStateCategoryEnum.safeParse(categoryRaw);
    if (parsed.success) filters.category = parsed.data;
  }
  if (reviewStateRaw) {
    const parsed = ReviewStateEnum.safeParse(reviewStateRaw);
    if (parsed.success) filters.reviewState = parsed.data;
  }
  if (sourceTypeRaw) {
    const parsed = SourceTypeEnum.safeParse(sourceTypeRaw);
    if (parsed.success) filters.sourceType = parsed.data;
  }
  const q = c.req.query('q');
  if (q && q.trim()) filters.q = q.trim();
  const domain = c.req.query('domain');
  if (domain && domain.trim()) filters.domain = domain.trim();
  const cohortId = c.req.query('cohortId');
  if (cohortId && cohortId.trim()) filters.cohortId = cohortId.trim();
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
  const offset = offsetRaw ? Number.parseInt(offsetRaw, 10) : NaN;
  if (Number.isFinite(limit)) filters.limit = limit;
  if (Number.isFinite(offset)) filters.offset = offset;
  if (cursorRaw && cursorRaw.trim()) filters.cursor = cursorRaw.trim();
  return filters;
}

/**
 * GET /api/onboarding/batches/:id/work-state
 * Server-derived operator work-state projection for the Batch Workspace.
 * @deprecated — use /work-state/counts + /work-state/items (cursor) for bounded reads.
 */
route.get('/onboarding/batches/:id/work-state', async (c) => {
  const batchId = c.req.param('id');
  const batch = findBatchById(batchId);
  if (!batch) {
    return c.json({ error: 'Batch not found' }, 404);
  }
  const workspace = findWorkspace();
  if (!workspace || batch.workspaceId !== workspace.id) {
    return c.json({ error: 'Batch not found' }, 404);
  }
  const filters = parseWorkStateFilters(c);
  try {
    const payload = getBatchWorkState(batchId, filters);
    return c.json(payload);
  } catch (err) {
    if (err instanceof WorkStateCursorError) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
    if (err instanceof WorkStateProjectionError) {
      const health = (err as any).health ?? buildProjectionHealth([{ source: (err as WorkStateProjectionError).source, code: (err as WorkStateProjectionError).code, affectedCount: 1 }]);
      return c.json({ error: 'projection_failed', code: (err as WorkStateProjectionError).code, projectionHealth: health }, 503);
    }
    throw err;
  }
});

/**
 * GET /api/onboarding/batches/:id/work-state/counts
 * Bounded work-state counts (Milestone 3 / P1-E). Always includes projectionHealth.
 */
route.get('/onboarding/batches/:id/work-state/counts', async (c) => {
  const batchId = c.req.param('id');
  const batch = findBatchById(batchId);
  if (!batch) {
    return c.json({ error: 'Batch not found' }, 404);
  }
  const workspace = findWorkspace();
  if (!workspace || batch.workspaceId !== workspace.id) {
    return c.json({ error: 'Batch not found' }, 404);
  }
  const filters = parseWorkStateFilters(c);
  try {
    const countsPayload = getBatchWorkStateCountsWithHealth(batchId, {
      category: filters.category,
      q: filters.q,
      domain: filters.domain,
      sourceType: filters.sourceType,
      cohortId: filters.cohortId,
      reviewState: filters.reviewState,
    });
    return c.json({ batchId, ...countsPayload });
  } catch (err) {
    if (err instanceof WorkStateProjectionError) {
      const health = (err as any).health ?? buildProjectionHealth([{ source: (err as WorkStateProjectionError).source, code: (err as WorkStateProjectionError).code, affectedCount: 1 }]);
      return c.json({ error: 'projection_failed', code: (err as WorkStateProjectionError).code, projectionHealth: health }, 503);
    }
    throw err;
  }
});

/**
 * GET /api/onboarding/batches/:id/work-state/items?cursor&limit
 * Cursor-paginated work-state items (Milestone 3 / P1-E). Always includes projectionHealth.
 */
route.get('/onboarding/batches/:id/work-state/items', async (c) => {
  const batchId = c.req.param('id');
  const batch = findBatchById(batchId);
  if (!batch) {
    return c.json({ error: 'Batch not found' }, 404);
  }
  const workspace = findWorkspace();
  if (!workspace || batch.workspaceId !== workspace.id) {
    return c.json({ error: 'Batch not found' }, 404);
  }
  const filters = parseWorkStateFilters(c);
  try {
    const page = getBatchWorkStateItems(batchId, filters);
    return c.json({ batchId, items: page.items, nextCursor: page.nextCursor, projectionHealth: page.projectionHealth, scannedRows: (page as any).scannedRows ?? 0, queryCount: (page as any).queryCount ?? 0 });
  } catch (err) {
    if (err instanceof WorkStateCursorError) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
    if (err instanceof WorkStateProjectionError) {
      const health = (err as any).health ?? buildProjectionHealth([{ source: (err as WorkStateProjectionError).source, code: (err as WorkStateProjectionError).code, affectedCount: 1 }]);
      return c.json({ error: 'projection_failed', code: (err as WorkStateProjectionError).code, projectionHealth: health }, 503);
    }
    console.error('[WorkState] Unexpected error in getBatchWorkStateItems:', err);
    return c.json({ error: 'Failed to generate work-state projection' }, 500);
  }
});

/**
 * GET /api/onboarding/batches/:id/review-queue
 * Bounded, cursor-paginated review queue projection (Milestone 1 / P1-C).
 */
route.get('/onboarding/batches/:id/review-queue', async (c) => {
  const batchId = c.req.param('id');
  const batch = findBatchById(batchId);
  if (!batch) {
    return c.json({ error: 'Batch not found' }, 404);
  }
  const workspace = findWorkspace();
  if (!workspace || batch.workspaceId !== workspace.id) {
    return c.json({ error: 'Batch not found' }, 404);
  }

  const limitRaw = c.req.query('limit');
  const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  const warningsOnlyRaw = c.req.query('warningsOnly');
  const reviewStatesRaw = c.req.query('reviewStates');

  const filterInput: Record<string, unknown> = {
    cursor: c.req.query('cursor') || undefined,
    limit: Number.isFinite(limitParsed) ? limitParsed : undefined,
    warningsOnly: warningsOnlyRaw === 'true' || warningsOnlyRaw === '1' ? true : undefined,
    gateStatus: c.req.query('gateStatus') || undefined,
    familyCohortId: c.req.query('familyCohortId') || undefined,
    brand: c.req.query('brand') || undefined,
    sourceType: c.req.query('sourceType') || undefined,
    q: c.req.query('q') || undefined,
  };

  if (reviewStatesRaw) {
    filterInput.reviewStates = reviewStatesRaw.split(',').map(s => s.trim()).filter(Boolean);
  }

  const parsedFilters = ReviewQueueFiltersSchema.safeParse(filterInput);
  if (!parsedFilters.success) {
    return c.json({ error: 'Invalid query filters', details: parsedFilters.error.format() }, 400);
  }

  try {
    const queuePage = getBatchReviewQueue(batchId, parsedFilters.data, { workspaceId: workspace.id });
    return c.json(queuePage);
  } catch (err) {
    if (err instanceof ReviewQueueCursorError) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
    console.error('[ReviewQueue] Unexpected error in getBatchReviewQueue:', err);
    return c.json({ error: 'Failed to generate review queue projection' }, 500);
  }
});

/**
 * GET /api/onboarding/items/:id/work-state
 * Single-item operator work-state projection.
 */
route.get('/onboarding/items/:id/work-state', async (c) => {
  const itemId = c.req.param('id');
  const item = findItemById(itemId);
  if (!item) {
    return c.json({ error: 'Item not found' }, 404);
  }
  const workspace = findWorkspace();
  const batch = findBatchById(item.batchId);
  if (!workspace || !batch || batch.workspaceId !== workspace.id) {
    return c.json({ error: 'Onboarding item not found' }, 404);
  }
  const workState = getItemWorkState(itemId);
  return c.json({ workState });
});

/**
 * POST /api/onboarding/batches/:id/verify-distributor-imagery
 * Run the deterministic PI-6 verification pipeline over the batch's approved
 * distributor imagery (epic #46 follow-up). Seeds supplier-tier reuse grants
 * for the image domains (the operator's distributor-channel opt-in), runs
 * byte-bound OCR + identity classification per image, and persists durable
 * `product_intelligence_assets` rows (origin 'onboarding_distributor').
 * Idempotent: already-verified URLs are skipped. Workspace-scoped.
 */
route.post('/onboarding/batches/:id/verify-distributor-imagery', async (c) => {
  const batchId = c.req.param('id');
  const batch = findBatchById(batchId);
  if (!batch) {
    return c.json({ error: 'Batch not found' }, 404);
  }
  const workspace = findWorkspace();
  if (!workspace || batch.workspaceId !== workspace.id) {
    return c.json({ error: 'Batch not found' }, 404);
  }
  try {
    const summary = await verifyDistributorImageryForBatch(batchId, workspace.id, workspace.workspacePath);
    return c.json({ summary });
  } catch (err) {
    console.error(`[VerifyDistributorImagery] Batch ${batchId} verification failed:`, err);
    return c.json({ error: err instanceof Error ? err.message : 'Distributor imagery verification failed' }, 500);
  }
});

/**
 * GET /api/onboarding/batches/:id/extractor-profile-blockers
 * Domain-level extractor setup queue (epic #46 follow-up, GPT plan phase 5):
 * missing-profile extraction failures grouped by source domain, sorted by
 * blocked-product count, with per-domain sample items and profile status.
 * Workspace-scoped like every batch projection.
 */
route.get('/onboarding/batches/:id/extractor-profile-blockers', async (c) => {
  const batchId = c.req.param('id');
  const batch = findBatchById(batchId);
  if (!batch) {
    return c.json({ error: 'Batch not found' }, 404);
  }
  const workspace = findWorkspace();
  if (!workspace || batch.workspaceId !== workspace.id) {
    return c.json({ error: 'Batch not found' }, 404);
  }
  return c.json({ blockers: getExtractorProfileDomainBlockers(batchId) });
});

/**
 * POST /api/onboarding/batches/:id/approve
 * Bulk approval of reviewed items. Per-item structured outcomes — partial
 * failures are visible and retryable. Guardrails (epic #46 Phase 7):
 * - only items with a durable, non-invalidated review can be approved;
 * - the item must be `review / completed` and pass the existing semantic/
 *   review-completion gate (run-linked items);
 * - approval writes durable state + advances the item review → promotion
 *   automatically; it NEVER exports/publishes anything.
 */
route.post('/onboarding/batches/:id/approve', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const batchId = c.req.param('id');
  const batch = findBatchById(batchId);
  if (!batch) {
    return c.json({ error: 'Batch not found' }, 404);
  }
  if (batch.workspaceId !== workspace.id) {
    return c.json({ error: 'Batch not found' }, 404);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body.' }, 400);
  }
  const parsed = ApproveItemsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid approval payload.', issues: parsed.error.issues }, 400);
  }

  const principal = derivePrincipal(c);
  if (!principal) {
    return c.json({ error: 'Unauthorized', code: 'unauthorized' }, 401);
  }
  if (principal.role !== 'catalog_approver' && principal.role !== 'system') {
    return c.json({ error: 'Forbidden', code: 'forbidden' }, 403);
  }
  const approvedBy = principal.actor;
  const idempotencyKey = c.req.header('Idempotency-Key') ?? c.req.header('idempotency-key') ?? null;
  const originalHash = computeRequestHash(parsed.data.itemIds);
  const originalItemIds = parsed.data.itemIds;

  // Early idempotent replay before mutable validation (P1-D: identical retry replays previous response)
  if (idempotencyKey) {
    const incomingHash = originalHash;
    const existing = findByScopedIdempotencyKey(workspace.id, batchId, 'approve', idempotencyKey);
    if (existing) {
      if (existing.requestHash !== incomingHash) {
        return c.json({ error: 'payload_mismatch', code: 'payload_mismatch', receiptId: existing.id }, 409);
      }
      if (existing.status === 'started' && !existing.detailsJson) {
        return c.json({ error: 'operation_in_progress', code: 'operation_in_progress', receiptId: existing.id }, 409);
      }
      if (existing.detailsJson) {
        try {
          const stored = JSON.parse(existing.detailsJson) as { approved?: string[]; rejected?: Array<{ itemId: string; reason: string }>; principal?: string; role?: string; results?: Array<{ itemId: string; status: string; reason: string | null }>; approvedCount?: number; rejectedCount?: number; audited?: boolean; receiptId?: string };
          // If stored is full envelope (with receiptId and results), replay it IDENTICALLY
          if (Array.isArray(stored.results) && typeof stored.receiptId === 'string' && typeof stored.approvedCount === 'number') {
            return c.json(stored);
          }
          if (Array.isArray(stored.results) && typeof stored.approvedCount === 'number') {
            return c.json({
              results: stored.results,
              approvedCount: stored.approvedCount,
              rejectedCount: stored.rejectedCount ?? (stored.rejected?.length ?? 0),
              rejected: stored.rejected ?? [],
              audited: stored.audited ?? true,
              receiptId: existing.id,
              principal: stored.principal ?? existing.principal,
            });
          }
          if (Array.isArray(stored.approved)) {
            const approved = stored.approved;
            const rejectedStored = stored.rejected ?? [];
            const results = [
              ...approved.map(itemId => ({ itemId, status: 'approved' as const, reason: null })),
              ...rejectedStored.map(r => ({ itemId: r.itemId, status: 'rejected' as const, reason: r.reason })),
            ];
            return c.json({
              results,
              approvedCount: approved.length,
              rejectedCount: rejectedStored.length,
              rejected: rejectedStored,
              audited: true,
              receiptId: existing.id,
              principal: stored.principal ?? existing.principal,
            });
          }
        } catch {}
      }
      return c.json({ results: [], approvedCount: 0, rejectedCount: 0, rejected: [], audited: true, receiptId: existing.id, principal: existing.principal });
    }
  }

  // ── Phase 1: validate every item (per-item, fail-closed reasons) ───────
  const validIds: string[] = [];
  const rejected: Array<{ itemId: string; reason: string }> = [];
  for (const id of parsed.data.itemIds) {
    const item = findItemById(id);
    if (!item) {
      rejected.push({ itemId: id, reason: 'item_not_found' });
      continue;
    }
    if (item.batchId !== batchId) {
      rejected.push({ itemId: id, reason: 'item_not_in_batch' });
      continue;
    }
    if (item.stage !== 'review' || item.stageStatus !== 'completed') {
      rejected.push({ itemId: id, reason: `not_eligible:${item.stage}/${item.stageStatus}` });
      continue;
    }
    const reviewState = getReviewState(id);
    if (!reviewState?.reviewedAt) {
      rejected.push({ itemId: id, reason: 'not_reviewed' });
      continue;
    }
    if (reviewState.reviewInvalidatedAt) {
      rejected.push({ itemId: id, reason: 'review_invalidated' });
      continue;
    }
    if (reviewState.approvedAt) {
      rejected.push({ itemId: id, reason: 'already_approved' });
      continue;
    }
    // Run-linked items pass the SAME review-completion gate the review flow
    // enforces (semantic validation + type gates). Legacy items (no run)
    // have no gate.
    const runId = item.curationData?.classificationRunId;
    if (runId) {
      const gate = validateReviewCompletionGate({
        workspaceId: workspace.id,
        onboardingItemId: id,
        productSku: item.upc,
        activeRunId: runId,
      });
      if (!gate.ok) {
        rejected.push({ itemId: id, reason: gate.reason });
        continue;
      }
    }
    validIds.push(id);
  }

  // ── Phase 2: ATOMIC durable approval + review→promotion advance + receipt + audit ──────
  // Receipt + approval + audit in ONE transaction (Milestone 4 / P1-D). Idempotency via Idempotency-Key.
  // Server-derived principal beats client reviewerId. Handle payload_mismatch 409 from scoped receipt hash check.
  let advancedIds: string[];
  let atomicRejected: Array<{ itemId: string; reason: string }>;
  let receiptId: string | undefined;
  try {
    const res = approveAndAdvanceItems({
      itemIds: validIds,
      batchId,
      approvedBy,
      origin: 'bulk',
      principal: principal.actor,
      role: principal.role,
      idempotencyKey,
      workspaceId: workspace.id,
      requestHash: originalHash,
      preRejected: rejected,
    });
    advancedIds = res.approved;
    atomicRejected = res.rejected;
    receiptId = res.receiptId;
  } catch (e: any) {
    if (e?.code === 'payload_mismatch') {
      return c.json({ error: 'payload_mismatch', code: 'payload_mismatch', receiptId: e.existingReceiptId }, 409);
    }
    throw e;
  }
  for (const id of advancedIds) {
    onboardingEvents.emitItemStatus(findItemById(id)?.batchId ?? batchId, id, 'approved', {
      stage: 'promotion',
      approvalOrigin: 'bulk',
    });
  }
  rejected.push(...atomicRejected);

  // ── Phase 3: structured outcome ─────────────────────────────────────────
  const results = [
    ...advancedIds.map(itemId => ({ itemId, status: 'approved' as const, reason: null })),
    ...rejected.map(r => ({ itemId: r.itemId, status: 'rejected' as const, reason: r.reason })),
  ];
  const approvedCount = advancedIds.length;
  const rejectedCount = rejected.length;

  // Batch audit already done inside transaction with finalRejected; also ensure idempotency replay handled
  return c.json({ results, approvedCount, rejectedCount, rejected, audited: true, receiptId, principal: principal.actor });
});

/**
 * POST /api/onboarding/batches/:id/create-export-drafts
 * Separate export-draft operation with its own idempotency lifecycle (P1-D item 5).
 * Requires catalog_exporter, revalidates durable approval immediately before draft mutation, never auto-approves.
 */
route.post('/onboarding/batches/:id/create-export-drafts', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) return c.json({ error: 'No active workspace loaded' }, 400);
  const batchId = c.req.param('id');
  const batch = findBatchById(batchId);
  if (!batch) return c.json({ error: 'Batch not found' }, 404);
  if (batch.workspaceId !== workspace.id) return c.json({ error: 'Batch not found' }, 404);
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON body.' }, 400); }
  const parsed = ApproveItemsRequestSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid export draft payload.', issues: parsed.error.issues }, 400);
  const principal = derivePrincipalForOperation(c, 'export');
  if (!principal) return c.json({ error: 'Unauthorized', code: 'unauthorized' }, 401);
  if (principal.role !== 'catalog_exporter' && principal.role !== 'system') return c.json({ error: 'Forbidden', code: 'forbidden' }, 403);
  const idempotencyKey = c.req.header('Idempotency-Key') ?? c.req.header('idempotency-key') ?? null;
  const originalHash = computeRequestHash(parsed.data.itemIds);
  if (idempotencyKey) {
    const existing = findByScopedIdempotencyKey(workspace.id, batchId, 'export', idempotencyKey);
    if (existing) {
      if (existing.requestHash !== originalHash) return c.json({ error: 'payload_mismatch', code: 'payload_mismatch', receiptId: existing.id }, 409);
      if (existing.status === 'started' && !existing.detailsJson) return c.json({ error: 'operation_in_progress', code: 'operation_in_progress', receiptId: existing.id }, 409);
      if (existing.detailsJson) {
        try { const stored = JSON.parse(existing.detailsJson); if (stored.receiptId && Array.isArray(stored.results)) return c.json(stored); } catch {}
        // Fallback: return stored details
        try { const stored = JSON.parse(existing.detailsJson); return c.json({ ...stored, receiptId: existing.id }); } catch {}
      }
    }
  }
  // Pre-validation (fail-closed reasons, no mutation yet)
  const preRejected: Array<{ itemId: string; reason: string }> = [];
  const validIds: string[] = [];
  for (const id of parsed.data.itemIds) {
    const item = findItemById(id);
    if (!item) { preRejected.push({ itemId: id, reason: 'item_not_found' }); continue; }
    if (item.batchId !== batchId) { preRejected.push({ itemId: id, reason: 'item_not_in_batch' }); continue; }
    validIds.push(id);
  }
  try {
    const res = createExportDraftsWithReceipt({
      itemIds: validIds,
      batchId,
      requestedBy: principal.actor,
      principal: principal.actor,
      role: principal.role,
      idempotencyKey,
      workspaceId: workspace.id,
      requestHash: originalHash,
      preRejected,
    });
    // Build response envelope matching approve shape but with export lifecycle fields
    const finalRejected = [...preRejected, ...res.rejected];
    const results = [
      ...res.created.map(itemId => ({ itemId, status: 'created' as const, reason: null })),
      ...finalRejected.map(r => ({ itemId: r.itemId, status: 'rejected' as const, reason: r.reason })),
    ];
    return c.json({
      results,
      createdCount: res.created.length,
      rejectedCount: finalRejected.length,
      rejected: finalRejected,
      created: res.created,
      changeSetId: res.changeSetId,
      audited: true,
      receiptId: res.receiptId,
      principal: principal.actor,
    });
  } catch (e: any) {
    if (e?.code === 'payload_mismatch') return c.json({ error: 'payload_mismatch', code: 'payload_mismatch', receiptId: e.existingReceiptId }, 409);
    if (e?.code === 'operation_in_progress') return c.json({ error: 'operation_in_progress', code: 'operation_in_progress', receiptId: e.existingReceiptId }, 409);
    throw e;
  }
});

/**
 * POST /api/onboarding/domains/:domain/release
 * Deterministic domain-level release (epic #46 UX workstream 4 / Phase 8):
 * after an extractor profile becomes usable for a domain, every blocked
 * extraction item on that domain is re-queued automatically. Delegates to
 * the canonical `releaseDomainExtractionItems` primitive (Phase 2) with
 * `releaseAllBlocked` — this is the explicit operator-triggered release (the
 * profile was just set up), so every blocked item on the domain releases.
 * A missing profile fails closed (400).
 */
route.post('/onboarding/domains/:domain/release', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const domain = c.req.param('domain').trim().toLowerCase().replace(/^www\./, '');
  if (!domain) {
    return c.json({ error: 'domain is required' }, 400);
  }

  const result = releaseDomainExtractionItems(workspace.id, domain, { releaseAllBlocked: true });
  if (!result.profileAvailable) {
    return c.json({ error: `No usable extractor profile for "${domain}"` }, 400);
  }

  const releasedIds = result.releasedIds;
  const skippedCount = result.skipped.filter(entry => entry.itemId).length;

  // Trigger the worker so re-queued items are picked up immediately.
  if (releasedIds.length > 0) {
    triggerWorkerPoll(workspace.id, workspace.workspacePath);
  }

  addAuditLog({
    workspaceId: workspace.id,
    entityType: 'extractor_profile_domain',
    entityId: domain,
    action: 'domain_release',
    message: `Released ${releasedIds.length} blocked extraction item(s) on ${domain} after profile became usable`,
    detailsJson: JSON.stringify({ released: releasedIds, skippedCount }),
  });

  return c.json({ domain, releasedItemIds: releasedIds, count: releasedIds.length, skippedCount });
});

/**
 * POST /api/onboarding/items/:id/submit-manual-evidence
 * Parent #101 (manual-evidence route, ticket #103 thin slice): audited
 * operator submission of manual evidence for one profile-blocked item
 * (`extraction/failed` → `extraction/completed`). Strict body (server
 * derives all provenance); any authenticated principal may submit, and the
 * principal actor is recorded as the attesting operator.
 */
route.post('/onboarding/items/:id/submit-manual-evidence', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }
  const principal = derivePrincipal(c);
  if (!principal) {
    return c.json({ error: 'Unauthorized', code: 'unauthorized' }, 401);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body.' }, 400);
  }
  const parsed = SubmitManualEvidenceRequestSchema.safeParse({ ...(body as Record<string, unknown>), itemId: c.req.param('id') });
  if (!parsed.success) {
    return c.json({ error: 'Invalid manual-evidence payload.', issues: parsed.error.issues }, 400);
  }
  const { submitManualEvidence } = await import('../../onboarding/manual-evidence-service');
  const result = submitManualEvidence({
    itemId: parsed.data.itemId,
    workspaceId: workspace.id,
    operatorId: principal.actor,
    title: parsed.data.title,
    brand: parsed.data.brand,
    description: parsed.data.description,
    bulletPoints: parsed.data.bulletPoints,
    weight: parsed.data.weight,
    dimensions: parsed.data.dimensions,
    primaryImage: parsed.data.primaryImage,
    additionalImages: parsed.data.additionalImages,
    fieldSources: parsed.data.fieldSources,
    imageApprovals: parsed.data.imageApprovals,
    familyReferenceText: parsed.data.familyReferenceText,
    familyReferenceUrl: parsed.data.familyReferenceUrl,
    familyPageOnlyConfirmed: parsed.data.familyPageOnlyConfirmed,
    overrideDistributorReason: parsed.data.overrideDistributorReason,
    attestation: parsed.data.attestation,
  });
  if (!result.ok) {
    const status = result.code === 'workspace_mismatch' || result.code === 'item_not_found' ? 404 : 422;
    return c.json({ error: result.reason, code: result.code }, status);
  }
  addAuditLog({
    workspaceId: workspace.id,
    entityType: 'onboarding_item',
    entityId: parsed.data.itemId,
    action: 'submit_manual_evidence',
    message: `Operator ${principal.actor} submitted manual evidence (attestation ${result.attestationId})`,
    detailsJson: JSON.stringify({ attestationId: result.attestationId, extractionId: result.extractionId }),
  });
  return c.json({ itemId: parsed.data.itemId, attestationId: result.attestationId, extractionId: result.extractionId });
});

/**
 * POST /api/onboarding/items/:id/withdraw-manual-evidence
 * Parent #101: operator withdrawal restores the prior blocked state.
 */
route.post('/onboarding/items/:id/withdraw-manual-evidence', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }
  const principal = derivePrincipal(c);
  if (!principal) {
    return c.json({ error: 'Unauthorized', code: 'unauthorized' }, 401);
  }
  const { withdrawManualEvidence } = await import('../../onboarding/manual-evidence-service');
  const result = withdrawManualEvidence({
    itemId: c.req.param('id'),
    workspaceId: workspace.id,
    operatorId: principal.actor,
  });
  if (!result.ok) {
    const status = result.code === 'workspace_mismatch' || result.code === 'item_not_found' ? 404 : 422;
    return c.json({ error: result.reason, code: result.code }, status);
  }
  addAuditLog({
    workspaceId: workspace.id,
    entityType: 'onboarding_item',
    entityId: c.req.param('id'),
    action: 'withdraw_manual_evidence',
    message: `Operator ${principal.actor} withdrew manual evidence (superseded ${result.supersededAttestationId})`,
    detailsJson: JSON.stringify({ supersededAttestationId: result.supersededAttestationId }),
  });
  return c.json({ itemId: c.req.param('id'), supersededAttestationId: result.supersededAttestationId });
});

/**
 * GET /api/onboarding/items/:id/manual-evidence
 * Parent #101: read model for the active manual attestation (null when none).
 * Ticket #104 adds an optional read-only `distributorReference` carrying the
 * item's qualified distributor-record scalars (title/brand/description/
 * weight/dimensions) for side-by-side consultation while transcribing.
 * Display-only: the UI never auto-fills from it and submit never links to
 * it (no generation id, no attempt ids leave this endpoint).
 */
route.get('/onboarding/items/:id/manual-evidence', async (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }
  const principal = derivePrincipal(c);
  if (!principal) {
    return c.json({ error: 'Unauthorized', code: 'unauthorized' }, 401);
  }
  const itemId = c.req.param('id');
  const item = findItemById(itemId);
  if (!item) {
    return c.json({ error: 'Item not found', code: 'item_not_found' }, 404);
  }
  return c.json({
    itemId,
    attestation: getActiveManualEvidenceAttestationForItem(itemId),
    distributorReference: await readDistributorReferenceForManualEvidence(itemId),
  });
});

/**
 * Read-only distributor scalars for manual-evidence side-by-side display
 * (ticket #104). Returns display strings only — never generation/attempt
 * ids, so the UI cannot link or auto-fill from them.
 */
async function readDistributorReferenceForManualEvidence(itemId: string): Promise<Record<string, string> | null> {
  let row: { extraction_data_json: string | null } | undefined;
  try {
    // Dynamic import matches the submit/withdraw handlers above.
    const repo = await import('../../db/repositories/onboarding-extraction-repo');
    row = repo.findDistributorRecordExtraction(itemId);
  } catch {
    return null;
  }
  if (!row?.extraction_data_json) return null;
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.extraction_data_json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const pick = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 500) : null;
  const out: Record<string, string> = {};
  for (const field of ['title', 'brand', 'description', 'weight', 'dimensions'] as const) {
    const value = pick(data[field]);
    if (value !== null) out[field] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * GET /api/onboarding/metrics?batchId=<id>
 * Epic #46 observability — batch-scoped (when batchId is given) or global
 * onboarding success metrics, all derived from durable state at query time.
 * Every metric carries a derivation honesty marker (exact | approximation |
 * not_available).
 */
route.get('/onboarding/metrics', (c) => {
  const workspace = findWorkspace();
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const batchIdRaw = c.req.query('batchId');
  if (batchIdRaw) {
    const batch = findBatchById(batchIdRaw);
    if (!batch || batch.workspaceId !== workspace.id) {
      return c.json({ error: 'Batch not found' }, 404);
    }
  }

  const telemetry = getOnboardingMetrics({
    workspaceId: workspace.id,
    batchId: batchIdRaw ?? undefined,
  });
  return c.json(telemetry);
});

export default route;
