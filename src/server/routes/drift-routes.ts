import { Hono } from 'hono';
import { getCurrentWorkspace } from '../services/workspace-service';
import { detectDrift, acceptRemoteForDrift } from '../../shopsite/drift';
import { expandDriftToHunks, resolveSingleHunk } from '../../shopsite/drift-hunk-service';
import {
  createReconcileChangeSet,
  reopenReconcileDrift,
  importNewRemoteProduct,
  productKindForDrift,
} from '../../shopsite/drift-reconcile-service';
import {
  freezeBulkSelection,
  approveBulkSelection,
  DRIFT_BULK_MAX_HUNKS,
} from '../../shopsite/drift-bulk-service';
import { parseDriftDiff } from '../../shopsite/drift-hunks';
import { runDriftRetention, getDriftRetentionStats } from '../../shopsite/drift-retention';
import {
  listDriftAuditHistory,
  countDriftAuditHistory,
} from '../../db/repositories/audit-log-repo';
import {
  listDrift,
  findDriftById,
  resolveDrift,
  countDrift,
  getDriftCounts,
  parseDriftPageParams,
  listDriftHunkSources,
} from '../../db/repositories/drift-repo';
import { createSyncJob, addSyncJobEvent, completeSyncJob } from '../../db/repositories/sync-job-repo';
import { addAuditLog } from '../../db/repositories/audit-log-repo';

const route = new Hono();

/**
 * POST /api/drift/check - Pull remote ShopSite data and detect drift.
 * Accepts remote XML as body text for testing; uses ShopSite HTTP client when not provided.
 */
route.post('/drift/check', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const body = await c.req.json().catch(() => ({})) as { remoteXml?: string };
  let xmlToCheck = (body.remoteXml ?? '').trim();

  if (!xmlToCheck) {
    // Try saved connection for live pull
    const { findConnection } = await import('../../db/repositories/connection-repo');
    const { ShopSiteHttpClient } = await import('../../shopsite/shopsite-http-client');
    const connection = findConnection(workspace.id);
    if (connection?.cgiBaseUrl && connection.merchantId && connection.passwordSecretRef) {
      const client = new ShopSiteHttpClient({
        cgiBaseUrl: connection.cgiBaseUrl,
        merchantId: connection.merchantId,
        password: connection.passwordSecretRef,
      });
      const result = await client.fetchProductsXml();
      if (!result.success || !result.data) {
        return c.json({ error: `Failed to pull remote ShopSite data: ${result.error ?? 'unknown error'}` }, 400);
      }
      xmlToCheck = result.data;
    } else {
      return c.json({
        error: 'No remote XML provided and no ShopSite connection configured. ' +
          'Paste ShopSite XML text into the Drift view, or configure a direct sync connection in Setup.',
      }, 400);
    }
  }

  const job = createSyncJob({ workspaceId: workspace.id, kind: 'pull_drift' });
  addSyncJobEvent({ syncJobId: job.id, level: 'info', message: 'Starting drift detection...' });

  try {
    const result = detectDrift(workspace.id, workspace.workspacePath, xmlToCheck);

    if (result.errors.length > 0 && result.drifts.length === 0) {
      addSyncJobEvent({ syncJobId: job.id, level: 'error', message: result.errors.join('; ') });
      completeSyncJob(job.id, 'failed', { errorSummary: result.errors.join('; ') });
      return c.json({ error: result.errors.join('; '), jobId: job.id }, 500);
    }

    addSyncJobEvent({
      syncJobId: job.id, level: 'info',
      message: `Drift detection complete: ${result.driftCount} product(s) differ from remote.`,
    });

    completeSyncJob(job.id, 'succeeded', { productCount: result.driftCount });

    addAuditLog({
      workspaceId: workspace.id,
      entityType: 'workspace',
      entityId: workspace.id,
      action: 'drift_check',
      message: `Drift check found ${result.driftCount} product(s) with remote changes`,
      detailsJson: JSON.stringify({ driftCount: result.driftCount, skus: result.drifts.map(d => d.sku) }),
    });

    return c.json({
      success: true,
      jobId: job.id,
      driftCount: result.driftCount,
      driftSkus: result.drifts.map(d => ({ id: d.id, sku: d.sku, status: d.status })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addSyncJobEvent({ syncJobId: job.id, level: 'error', message: msg });
    completeSyncJob(job.id, 'failed', { errorSummary: msg });
    return c.json({ error: msg, jobId: job.id }, 500);
  }
});

/**
 * GET /api/drift - List drift findings for the active workspace.
 *
 * Drift 2/6 (#251) contract:
 * - Every number is scoped to the active workspace; other workspaces never leak.
 * - `openCount` = outstanding `open` findings; `reconcileCount` = separate
 *   `in_reconcile` findings (never folded into or dropped from each other).
 * - `total` counts the same workspace + status filter as the returned rows,
 *   so a filtered list header always agrees with its rows (not the unfiltered
 *   dashboard). The unfiltered dashboard open count agrees with
 *   `?status=open` totals via the shared `getDriftCounts` snapshot.
 * - Pagination is stable (`detected_at DESC, id ASC`); oversized limits clamp
 *   to DRIFT_MAX_PAGE_SIZE, invalid limit/offset values are rejected (400).
 *
 * Drift 4/6 (#253): `?field=` scopes to product rows containing at least one
 * hunk for that exact field; `total` shares the field filter so filtered
 * headers agree with filtered rows. Each row carries its compact `hunks`
 * (field identity + before/after) so no finding exists that cannot say what
 * changed.
 */
route.get('/drift', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const status = c.req.query('status') || undefined;
  const field = c.req.query('field') || undefined;

  let limit: number;
  let offset: number;
  try {
    ({ limit, offset } = parseDriftPageParams(c.req.query('limit'), c.req.query('offset')));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }

  const drifts = listDrift(workspace.id, status, limit, offset, field);
  // Counts share the workspace scope; total shares the requested filters.
  const counts = getDriftCounts(workspace.id);
  const total = countDrift(workspace.id, status, field);

  // Load additional context for each drift, including field-level hunks.
  const enriched = drifts.map(d => {
    const localProduct = d.localJson ? JSON.parse(d.localJson) : null;
    const remoteProduct = d.remoteJson ? JSON.parse(d.remoteJson) : null;
    let hunks: Array<{ field: string; baselineValue: string | null; remoteValue: string | null }>;
    let productKind: 'new' | 'changed' = d.localJson != null ? 'changed' : 'new';
    try {
      const parsed = parseDriftDiff(d);
      hunks = parsed.hunks;
      productKind = productKindForDrift(parsed);
    } catch {
      hunks = [];
    }
    return {
      ...d,
      localProductName: localProduct?.core?.name ?? null,
      remoteProductName: remoteProduct?.core?.name ?? null,
      localPrice: localProduct?.core?.price ?? null,
      remotePrice: remoteProduct?.core?.price ?? null,
      hunks,
      productKind,
    };
  });

  return c.json({
    drifts: enriched,
    openCount: counts.open,
    reconcileCount: counts.reconcile,
    total,
    limit,
    offset,
    field: field ?? null,
  });
});

/**
 * GET /api/drift/hunks - List outstanding field-level hunks.
 *
 * Drift 4/6 (#253): one changed field yields one hunk; unchanged fields
 * yield none. Supports `?field=` filtering and groups via `fieldCounts`.
 * Workspace-scoped, stable ordering (sku ASC, field ASC), bounded
 * pagination (DRIFT_MAX_PAGE_SIZE clamp, 400 on invalid).
 */
route.get('/drift/hunks', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const status = c.req.query('status') || 'open';
  const field = c.req.query('field') || undefined;

  let limit: number;
  let offset: number;
  try {
    ({ limit, offset } = parseDriftPageParams(c.req.query('limit'), c.req.query('offset')));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }

  // Bounded source read: hunk sources exclude large blobs (diff_json only).
  const sources = listDriftHunkSources(workspace.id, status === 'all' ? undefined : status);
  const allHunks = sources.flatMap((s) => expandDriftToHunks(s));
  const filtered = field ? allHunks.filter((h) => h.field === field) : allHunks;
  // Stable ordering for pagination.
  filtered.sort((a, b) => {
    if (a.sku !== b.sku) return a.sku < b.sku ? -1 : 1;
    if (a.field !== b.field) return a.field < b.field ? -1 : 1;
    const ar = a.remoteValue ?? '';
    const br = b.remoteValue ?? '';
    if (ar !== br) return ar < br ? -1 : 1;
    const ab = a.baselineValue ?? '';
    const bb = b.baselineValue ?? '';
    if (ab !== bb) return ab < bb ? -1 : 1;
    return a.driftId < b.driftId ? -1 : 1;
  });

  const fieldCounts: Record<string, number> = {};
  for (const h of filtered) {
    fieldCounts[h.field] = (fieldCounts[h.field] ?? 0) + 1;
  }

  const total = filtered.length;
  const page = filtered.slice(offset, offset + limit);

  return c.json({
    hunks: page,
    total,
    fieldCounts,
    limit,
    offset,
    field: field ?? null,
    status,
  });
});

/**
 * GET /api/drift/audit - Queryable history of past drift decisions.
 *
 * Drift 6/6 (#255): insertion endpoints alone are not answerability. This
 * surface reads the compact decision audit written by the hunk slices
 * (#253/#254), the pre-hunk resolve path, and the legacy backfill — scoped
 * to the active workspace, bounded pagination (same contract as the drift
 * list: oversized limits clamp, invalid values are 400), stable ordering
 * (created_at DESC, id ASC). Optional exact filters: action, sku, field,
 * decision (all matched inside the compact details, never the pruned blobs).
 */
route.get('/drift/audit', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const action = c.req.query('action') || undefined;
  const sku = c.req.query('sku') || undefined;
  const field = c.req.query('field') || undefined;
  const decision = c.req.query('decision') || undefined;

  let limit: number;
  let offset: number;
  try {
    ({ limit, offset } = parseDriftPageParams(c.req.query('limit'), c.req.query('offset')));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }

  const filter = { action, sku, field, decision };
  const events = listDriftAuditHistory(workspace.id, filter, limit, offset);
  const total = countDriftAuditHistory(workspace.id, filter);

  return c.json({
    events,
    total,
    limit,
    offset,
    action: action ?? null,
    sku: sku ?? null,
    field: field ?? null,
    decision: decision ?? null,
  });
});

/**
 * GET /api/drift/retention/stats - Read-only retention snapshot.
 *
 * Reports legacy terminal rows, the server-side blob-size estimate, the
 * outstanding queue (never a prune candidate), and reusable freelist
 * capacity. Honest by construction: file shrinkage is never promised (see
 * vacuumNote).
 */
route.get('/drift/retention/stats', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const stats = getDriftRetentionStats(workspace.id);
  return c.json({ success: true, ...stats });
});

/**
 * POST /api/drift/retention/run - Backfill compact audit, verify, then prune.
 * Body: { batchSize?, maxBatches?, dryRun? }
 *
 * Drift 6/6 (#255): resumable (loop until remaining is 0) and idempotent
 * (reruns create no duplicate audits). Deletes happen only after the
 * corresponding audit evidence is durably re-read; unverified rows are
 * skipped, never deleted. Outstanding (`open`) and reconcile-linked
 * (`in_reconcile`) rows always survive. With dryRun:true nothing is
 * written or deleted; the response plans and measures instead.
 */
route.post('/drift/retention/run', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const body = (await c.req.json().catch(() => ({}))) as {
    batchSize?: unknown;
    maxBatches?: unknown;
    dryRun?: unknown;
  };
  try {
    const result = runDriftRetention(workspace.id, {
      batchSize: body.batchSize as number | undefined,
      maxBatches: body.maxBatches as number | undefined,
      dryRun: body.dryRun === true,
    });
    return c.json({ success: true, ...result });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, status as 400);
  }
});

/**
 * POST /api/drift/hunks/resolve - Explicit per-hunk resolution.
 * Body: { driftId, field, decision: 'accept'|'reject', baselineValue?,
 *   remoteValue?, expectedRemoteHash?, expectedBaselineCommit? }
 * No silent defaults: omitted or invalid decisions fail 400. New products
 * fail 409 toward the explicit import workflow; reconcile holds only linked
 * fields so unrelated hunks stay resolvable; unverified page accepts fail
 * 409 (reject to keep local, or reconcile for manual merge).
 * Stale baselines / newer remotes fail 409 before application.
 */
route.post('/drift/hunks/resolve', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const body = (await c.req.json().catch(() => ({}))) as {
    driftId?: string;
    field?: string;
    decision?: string;
    baselineValue?: string | null;
    remoteValue?: string | null;
    expectedRemoteHash?: string | null;
    expectedBaselineCommit?: string | null;
  };

  if (!body.driftId || !body.field) {
    return c.json({ error: 'Missing driftId or field: per-hunk resolution requires explicit hunk identity.' }, 400);
  }
  if (body.decision !== 'accept' && body.decision !== 'reject') {
    return c.json({ error: `Invalid decision "${String(body.decision)}". Use: accept, reject` }, 400);
  }

  try {
    const result = resolveSingleHunk(workspace.id, workspace.workspacePath, {
      driftId: body.driftId,
      field: body.field,
      decision: body.decision,
      baselineValue: body.baselineValue,
      remoteValue: body.remoteValue,
      expectedRemoteHash: body.expectedRemoteHash,
      expectedBaselineCommit: body.expectedBaselineCommit,
      actor: workspace.id,
    });
    return c.json({ success: true, ...result });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, status as 400);
  }
});

/**
 * POST /api/drift/:id/resolve - Resolve a drift row.
 * Options: keep_local, accept_remote, create_change_set
 * Drift 4/6 (#253): explicit decisions only — omitted or invalid actions
 * fail 400 rather than falling back to a silent default.
 * Drift 4b (#257): create_change_set accepts an optional `fields` subset for
 * selected-field reconciliation; new remote products reconcile as `create`.
 */
route.post('/drift/:id/resolve', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const driftId = c.req.param('id');
  const body = await c.req.json().catch(() => ({})) as { action?: string; fields?: unknown };
  const action = body.action;

  if (action !== 'keep_local' && action !== 'accept_remote' && action !== 'create_change_set') {
    return c.json({ error: `Invalid action "${String(action)}". Use: keep_local, accept_remote, create_change_set` }, 400);
  }

  const drift = findDriftById(driftId);
  if (!drift) return c.json({ error: 'Drift record not found.' }, 404);
  // Workspace-checked resolution (#251): another workspace's finding cannot
  // be resolved here (refused as not-found so membership never leaks).
  if (drift.workspaceId !== workspace.id) return c.json({ error: 'Drift record not found.' }, 404);
  if (drift.status !== 'open') return c.json({ error: `Drift status is "${drift.status}", not open.` }, 400);

  switch (action) {
    case 'keep_local':
      resolveDrift(driftId, 'kept_local');
      addAuditLog({
        workspaceId: workspace.id,
        entityType: 'drift',
        entityId: driftId,
        action: 'kept_local',
        message: `Kept local version for SKU "${drift.sku}" (remote changes discarded)`,
        detailsJson: JSON.stringify({ sku: drift.sku }),
      });
      return c.json({ success: true, action: 'kept_local', sku: drift.sku });

    case 'accept_remote': {
      const accepted = acceptRemoteForDrift(workspace.workspacePath, drift);
      resolveDrift(driftId, 'accepted_remote');
      addAuditLog({
        workspaceId: workspace.id,
        entityType: 'drift',
        entityId: driftId,
        action: 'accepted_remote',
        message: `Accepted remote version for SKU "${drift.sku}" into local Git catalog`,
        detailsJson: JSON.stringify({ sku: drift.sku, commitHash: accepted.commitHash }),
      });
      return c.json({ success: true, action: 'accepted_remote', sku: drift.sku, commitHash: accepted.commitHash });
    }

    case 'create_change_set': {
      // Field-selective reconcile through the reviewed change path (#257):
      // an explicit `fields` subset reconciles only those hunks while
      // unrelated outstanding fields stay resolvable. Omitted `fields`
      // reconciles every outstanding hunk. New remote products reconcile as
      // a `create` operation.
      let fields: string[] | undefined;
      if (body.fields !== undefined) {
        if (!Array.isArray(body.fields) || body.fields.some((f) => typeof f !== 'string' || f.trim() === '')) {
          return c.json({ error: 'Invalid fields: supply an array of non-empty comparison field names, or omit to reconcile all outstanding hunks.' }, 400);
        }
        fields = (body.fields as string[]).map((f) => f.trim());
      }
      try {
        const created = createReconcileChangeSet(workspace.id, workspace.workspacePath, {
          driftId,
          fields,
          actor: workspace.id,
        });
        return c.json({ success: true, action: 'created_reconcile_change_set', sku: created.sku, changeSetId: created.changeSetId, fields: created.fields, productKind: created.productKind });
      } catch (err) {
        const status = (err as { status?: number }).status ?? 500;
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: message }, status as 400);
      }
    }

    default:
      return c.json({ error: `Unknown action "${action}". Use: keep_local, accept_remote, create_change_set` }, 400);
  }
});

/**
 * POST /api/drift/:id/import-new - Explicit new-product workflow (#257).
 * Body: { confirmed: true, expectedRemoteHash? }
 *
 * Genuinely new remote products (no local baseline) import here — never via
 * per-hunk accept, which stays held with a pointer to this endpoint.
 * Workspace-checked, staleness-checked, filename-collision held, audited
 * with decision/actor/time/catalog reference.
 */
route.post('/drift/:id/import-new', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const driftId = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as {
    confirmed?: unknown;
    expectedRemoteHash?: unknown;
  };
  try {
    const result = importNewRemoteProduct(workspace.id, workspace.workspacePath, {
      driftId,
      confirmed: body.confirmed === true,
      expectedRemoteHash:
        typeof body.expectedRemoteHash === 'string' ? body.expectedRemoteHash : null,
      actor: workspace.id,
    });
    return c.json({ success: true, ...result });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, status as 400);
  }
});

/**
 * POST /api/drift/:id/reopen - Explicit reconcile reopen (#257).
 *
 * Releases one `in_reconcile` drift back to `open` with hunk content
 * preserved and the change set kept for reference. Every linked hunk
 * becomes resolvable again through the normal per-hunk path. Discarding the
 * change set reopens through the same transition.
 */
route.post('/drift/:id/reopen', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const driftId = c.req.param('id');
  try {
    const result = reopenReconcileDrift(workspace.id, driftId, workspace.id);
    return c.json({ success: true, ...result });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, status as 400);
  }
});

/**
 * POST /api/drift/bulk/preview - Freeze a filter-scoped bulk selection.
 * Body: { field }
 *
 * Drift 5/6 (#254) + trust-remote (#270): bulk requires an explicit scope —
 * one supported field or "*" for all eligible fields. Bare scope still fails.
 * Returns the frozen selection (explicit scope, hunk versions, baseline
 * reference, count) for operator review. Hunks arriving after the freeze are
 * excluded by construction.
 */
route.post('/drift/bulk/preview', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const body = (await c.req.json().catch(() => ({}))) as { field?: string };
  try {
    const frozen = freezeBulkSelection(workspace.id, workspace.workspacePath, body.field ?? '');
    return c.json({ success: true, ...frozen, maxHunks: DRIFT_BULK_MAX_HUNKS });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, status as 400);
  }
});

/**
 * POST /api/drift/bulk/approve - Approve a frozen bulk selection.
 * Body: { field, baselineCommit, hunks: [{driftId,sku,field,baselineValue,remoteValue,remoteHash,baselineCommit}], confirmed:true }
 *
 * Drift 5/6 (#254): revalidates staleness + filename ownership before
 * approval (including cross-batch collisions), commits through one bounded
 * reviewed change set mapping to one commit, bounds draft/validation/
 * approval/response/audit, and fails honestly (no false resolved/synced,
 * no unrelated staged changes, retry-safe).
 */
route.post('/drift/bulk/approve', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const body = (await c.req.json().catch(() => ({}))) as {
    field?: string;
    baselineCommit?: string | null;
    hunks?: Array<{
      driftId: string;
      sku: string;
      field: string;
      baselineValue: string | null;
      remoteValue: string | null;
      remoteHash: string;
      baselineCommit: string | null;
    }>;
    confirmed?: boolean;
  };
  try {
    const result = approveBulkSelection(workspace.id, workspace.workspacePath, {
      field: body.field ?? '',
      baselineCommit: body.baselineCommit ?? null,
      hunks: body.hunks ?? [],
      confirmed: body.confirmed,
      actor: workspace.id,
    });
    return c.json({ success: true, ...result });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, status as 400);
  }
});

/**
 * POST /api/drift/bulk-resolve - Filter-scoped bulk accept (single-step).
 * Body: { field, action?: 'accept_remote' }
 *
 * Drift 5/6 (#254) + trust-remote (#270): a non-empty `field` scope is
 * required — one supported field or "*" for all eligible fields. Bare
 * accept-everything is not offered. Freezes the matching selection then
 * approves it through the same reviewed change path as /bulk/approve (one
 * bounded change set -> one commit, field-isolated merges). For a reviewable
 * freeze-then-confirm flow, use /bulk/preview + /bulk/approve instead.
 */
route.post('/drift/bulk-resolve', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const body = (await c.req.json().catch(() => ({}))) as { action?: string; field?: string };
  const action = body.action || 'accept_remote';

  if (action !== 'accept_remote') {
    return c.json({ error: 'Only accept_remote action is supported for bulk resolution.' }, 400);
  }
  if (!body.field || typeof body.field !== 'string' || body.field.trim() === '') {
    return c.json(
      { error: 'Bulk resolution requires an explicit filter scope: supply a non-empty "field" (e.g. "core.price") or "*" for all eligible fields. Bare accept-everything is not offered.' },
      400,
    );
  }

  try {
    const frozen = freezeBulkSelection(workspace.id, workspace.workspacePath, body.field);
    const isTrust = frozen.field === '*';
    if (frozen.count === 0) {
      return c.json({
        success: true,
        resolvedCount: 0,
        acceptedCount: 0,
        commitHash: null,
        changeSetId: null,
        field: frozen.field,
        resolvedSkus: [],
        skippedStale: [],
        skippedHeld: [],
        failed: [],
        message: isTrust ? 'No outstanding eligible hunks to resolve.' : `No outstanding "${frozen.field}" hunks to resolve.`,
      });
    }
    const result = approveBulkSelection(workspace.id, workspace.workspacePath, {
      field: frozen.field,
      baselineCommit: frozen.baselineCommit,
      hunks: frozen.hunks,
      confirmed: true,
      actor: workspace.id,
    });
    return c.json({
      success: true,
      resolvedCount: result.acceptedCount,
      acceptedCount: result.acceptedCount,
      commitHash: result.commitHash,
      changeSetId: result.changeSetId,
      field: result.field,
      resolvedSkus: result.resolvedSkus,
      skippedStale: result.skippedStale,
      skippedHeld: result.skippedHeld,
      failed: result.failed,
      message: result.field === '*'
        ? `Bulk accepted trust-remote (*) for ${result.acceptedCount} hunk(s) across ${result.resolvedSkus.length} product(s) via change set ${result.changeSetId}.`
        : `Bulk accepted remote ${result.field} for ${result.acceptedCount} product(s) via change set ${result.changeSetId}.`,
    });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, status as 400);
  }
});

export default route;
