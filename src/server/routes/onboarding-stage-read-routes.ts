/**
 * Slice 1 — dedicated v2 stage-read routes (council plan §4.1).
 *
 * - `GET /api/onboarding/v2/batches/:id/stage-work-state/counts`
 * - `GET /api/onboarding/v2/batches/:id/stage-work-state/items`
 *
 * Read-only. Never starts the worker (no poll trigger), never mutates rows.
 * Existing work-state read handlers are untouched; new stage/status reads
 * live only here. Mounted under /api so the existing API-token (GET bypass)
 * and workspace-autoload middleware apply unchanged.
 */
import { Hono } from 'hono';
import { findWorkspace } from '../../db/repositories/workspace-repo';
import { findBatchById } from '../../db/repositories/onboarding-batch-repo';
import {
  parseStageReadQueryParams,
  getStageReadCounts,
  getStageReadItems,
  StageReadInputError,
  StageReadScopeError,
  StageReadProjectionError,
} from '../../onboarding/onboarding-stage-read';
import { StageReadCursorError } from '../../shared/schemas/onboarding-stage-read';
import { buildProjectionHealth } from '../../onboarding/onboarding-work-state';
import { StageStorageError } from '../../db/repositories/onboarding-stage-vocabulary-repo';

const route = new Hono();

function workspaceScope(batchId: string): { workspaceId: string } | { error: Response } {
  const batch = findBatchById(batchId);
  if (!batch) return { error: Response.json({ error: 'Batch not found' }, { status: 404 }) };
  const workspace = findWorkspace();
  if (!workspace || batch.workspaceId !== workspace.id) {
    return { error: Response.json({ error: 'Batch not found' }, { status: 404 }) };
  }
  return { workspaceId: workspace.id };
}

function toErrorResponse(err: unknown): Response {
  // Slice 5b native: a row-boundary unknown-stage literal is a projection
  // failure (503 unknown_stage), never a 500 and never a false zero. The
  // fail-closed hydration throw below carries the same code the chunk
  // projector uses for stored literals that fail version validation, so
  // legacy-v1, canonical-v2, and corrupt rows all funnel identically.
  // Any other storage error (unknown metadata version, encode failure)
  // stays a 500 — it is not a projectable row.
  if (err instanceof StageStorageError && err.message.startsWith('Unknown onboarding stage value:')) {
    err = new StageReadProjectionError(
      'critical_projection_failure',
      'unknown_stage',
      buildProjectionHealth([{ source: 'onboarding_items', code: 'unknown_stage', affectedCount: 1 }]),
    );
  }
  if (err instanceof StageReadInputError) {
    return Response.json({ error: err.message, code: err.code }, { status: 400 });
  }
  if (err instanceof StageReadCursorError) {
    return Response.json({ error: err.message, code: err.code }, { status: 400 });
  }
  if (err instanceof StageReadScopeError) {
    return Response.json({ error: 'Batch not found' }, { status: 404 });
  }
  if (err instanceof StageReadProjectionError) {
    return Response.json(
      { error: 'projection_failed', code: err.code, projectionHealth: err.health },
      { status: 503 },
    );
  }
  return Response.json({ error: 'Failed to generate stage-read projection' }, { status: 500 });
}

route.get('/onboarding/v2/batches/:id/stage-work-state/counts', async c => {
  const batchId = c.req.param('id');
  const scope = workspaceScope(batchId);
  if ('error' in scope) return scope.error;
  try {
    const { filters } = parseStageReadQueryParams(c.req.queries() as Record<string, string[] | undefined>);
    const { cursor: _cursor, ...filterOnly } = filters;
    void _cursor;
    const payload = getStageReadCounts(batchId, filterOnly, { workspaceId: scope.workspaceId, batchId });
    return c.json(payload);
  } catch (err) {
    if (err instanceof Error && !(err instanceof StageReadProjectionError)) {
      console.error('[StageRead] Unexpected error in stage-work-state/counts:', err);
    }
    return toErrorResponse(err);
  }
});

route.get('/onboarding/v2/batches/:id/stage-work-state/items', async c => {
  const batchId = c.req.param('id');
  const scope = workspaceScope(batchId);
  if ('error' in scope) return scope.error;
  try {
    const { filters, limit } = parseStageReadQueryParams(c.req.queries() as Record<string, string[] | undefined>);
    const payload = getStageReadItems(batchId, filters, limit, { workspaceId: scope.workspaceId, batchId });
    return c.json(payload);
  } catch (err) {
    if (err instanceof Error && !(err instanceof StageReadProjectionError)) {
      console.error('[StageRead] Unexpected error in stage-work-state/items:', err);
    }
    return toErrorResponse(err);
  }
});

export default route;

/** Projection-failure helper kept adjacent for route tests (same 503 shape). */
export function stageReadProjectionFailed(code: string, affectedCount: number): Response {
  return Response.json(
    {
      error: 'projection_failed',
      code,
      projectionHealth: buildProjectionHealth([{ source: 'stage_read', code, affectedCount }]),
    },
    { status: 503 },
  );
}
