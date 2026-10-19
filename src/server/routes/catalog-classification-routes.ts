import { Hono } from 'hono';
import { getCurrentWorkspace } from '../services/workspace-service';
import { readProductFile } from '../../git/workspace-files';
import { classifyCatalogProduct } from '../../classification/catalog-product-classifier';
import { computeProductHash } from '../../classification/catalog-product-source';
import { getDb } from '../../db/connection';
import { getRecentCatalogRun, getAcceptedProposals, getEvidenceByRun, getLiveDecisionsByRun, getProposalsByRun, getStageResults, getRun, createRun, CatalogRunConflictError } from '../../db/repositories/classification-run-repo';
import { loadRuntimeConfigAuthority, createRuntimeActivationContext } from '../../classification/config-loader';
import { authorityConfigHashMatches, getRuntimeSnapshotByHash, runtimeSnapshotHashMatchesConfig } from '../../classification/runtime-snapshot';
import { projectCurrentReviewedDraft } from '../../classification/stages/draft-projection';
import { submitProposalDecisions } from '../../classification/proposal-review-service';
import { validateCatalogReviewCompletionGate } from '../../classification/review-completion-gate';
import { evaluateCanonicalReadiness } from '../../classification/classification-readiness';
import { applyCatalogClassification } from '../../classification/catalog-product-application';
import { ClassificationNotReadyError, normalizeClassificationReadinessReport } from '../../classification/readiness';
import { SubmitCatalogDecisionsRequestSchema } from '../../shared/schemas/classification';

const route = new Hono();

/**
 * GET /api/products/:sku/classification
 * Get the latest catalog classification run detail for a product SKU.
 */
route.get('/products/:sku/classification', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const sku = c.req.param('sku');
  const run = getRecentCatalogRun(workspace.id, sku);

  if (!run) {
    return c.json({ run: null, configDrift: false, sourceDrift: false, evidence: [], proposals: [], decisions: [], stageResults: [], classificationReadiness: null, draftProjection: null });
  }

  const evidence = getEvidenceByRun(run.id);
  const proposals = getProposalsByRun(run.id);
  const acceptedProposals = getAcceptedProposals(sku, run.id);
  const stageResults = getStageResults(run.id);

  const runtimeSnapshot = run.configSnapshotHash
    ? getRuntimeSnapshotByHash(workspace.id, run.configSnapshotHash)
    : null;
  const draftProjection = runtimeSnapshot && (run.status === 'completed' || run.status === 'completed_with_abstentions')
    ? await projectCurrentReviewedDraft({
        sku,
        expectedSnapshotHash: run.configSnapshotHash,
        sourceKind: 'catalog_product',
        evidence,
        proposals,
        acceptedProposals,
        stageResults,
      }, {
        workspacePath: workspace.workspacePath,
        workspaceId: workspace.id,
        runId: run.id,
        configSnapshotRef: runtimeSnapshot.configSnapshotRef,
        snapshot: runtimeSnapshot,
      })
    : null;

  const classificationReadiness = evaluateCanonicalReadiness({ workspaceId: workspace.id, runId: run.id });

  // Canonical current decisions only. Historical revisions remain available in
  // the database audit trail but must not be restored as the active UI state.
  const decisions = getLiveDecisionsByRun(run.id);

  // Drift detection — must use same hash functions as the classifier
  let sourceDrift = false;
  let configDrift = false;

  if (run.sourceProductHash && (run.status === 'completed' || run.status === 'completed_with_abstentions')) {
    const product = readProductFile(workspace.workspacePath, sku);
    if (product) {
      const currentHash = computeProductHash(product);
      if (currentHash !== run.sourceProductHash) sourceDrift = true;
    }
  }

  if (run.configSnapshotHash) {
    const authority = loadRuntimeConfigAuthority(workspace.workspacePath, createRuntimeActivationContext(workspace.workspacePath, workspace.id));
    const matches =
      authorityConfigHashMatches(authority, run.configSnapshotHash) ||
      runtimeSnapshotHashMatchesConfig(
        workspace.id,
        run.configSnapshotHash,
        authority.kind === 'v2' ? authority.bundle : authority.config,
      );
    if (!matches) configDrift = true;
  }

  return c.json({
    run: {
      id: run.id,
      status: run.status,
      productSku: run.productSku,
      sourceKind: run.sourceKind,
      configSnapshotHash: run.configSnapshotHash,
      sourceProductHash: run.sourceProductHash,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      errorMessage: run.errorMessage,
    },
    configDrift,
    sourceDrift,
    evidence,
    proposals,
    decisions,
    classificationReadiness,
    stageResults,
    draftProjection,
  });
});

/**
 * POST /api/products/:sku/classification/runs
 * Run classification for a product SKU. With an `idempotencyKey` body,
 * the start is queued + idempotent (P2 #19): same key replays the same
 * run id with 202 (even after completion); a different key against an
 * active SKU conflicts 409 with the active run id. Without a key, the
 * legacy synchronous execution path runs unchanged.
 */
route.post('/products/:sku/classification/runs', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const sku = c.req.param('sku');

  // Read product
  const product = readProductFile(workspace.workspacePath, sku);
  if (!product) return c.json({ error: `Product not found: ${sku}` }, 404);

  const keyedBody = (await c.req.json().catch(() => ({}))) as { idempotencyKey?: unknown };
  const idempotencyKey = typeof keyedBody.idempotencyKey === 'string' && keyedBody.idempotencyKey.trim()
    ? keyedBody.idempotencyKey.trim()
    : null;
  if (idempotencyKey) {
    try {
      const run = createRun(workspace.id, sku, null, null, { sourceKind: 'catalog_product', idempotencyKey });
      return c.json({ runId: run.id, status: run.status, queued: run.status === 'queued' }, 202);
    } catch (err) {
      if (err instanceof CatalogRunConflictError) {
        return c.json({ error: 'A classification run is already in progress for this product.', activeRunId: err.activeRunId }, 409);
      }
      throw err;
    }
  }

  // Check for existing running catalog run
  const runningRun = getDb().query(
    `SELECT id FROM classification_runs
     WHERE workspace_id = ? AND product_sku = ? AND source_kind = 'catalog_product' AND status = 'running'`,
  ).get(workspace.id, sku);
  if (runningRun) {
    return c.json({ error: 'A classification run is already in progress for this product.' }, 409);
  }

  try {
    const result = await classifyCatalogProduct(workspace.id, workspace.workspacePath, product);
    if (!result.success) {
      return c.json({ error: result.error || 'Classification failed.' }, 409);
    }
    return c.json(result);
  } catch (err) {
    if (err instanceof ClassificationNotReadyError) {
      return c.json({
        error: err.message,
        code: err.code,
        readiness: normalizeClassificationReadinessReport(err.readiness),
      }, 409);
    }
    console.error(`[CatalogClassificationRoutes] Classification failed for ${sku}:`, err);
    return c.json({ error: err instanceof Error ? err.message : 'Classification failed.' }, 500);
  }
});

/**
 * POST /api/products/:sku/classification/runs/:runId/decisions
 */
route.post('/products/:sku/classification/runs/:runId/decisions', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const sku = c.req.param('sku');
  const runId = c.req.param('runId');

  const run = getRecentCatalogRun(workspace.id, sku);
  if (!run || run.id !== runId) {
    return c.json({ error: 'Run not found for this SKU and workspace.' }, 404);
  }

  let body: any;
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    return c.json({ error: 'Invalid JSON body.' }, 400);
  }

  const parsed = SubmitCatalogDecisionsRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid decisions payload.', issues: parsed.error.issues }, 400);
  }
  if (parsed.data.decisions.length === 0) {
    return c.json({ error: 'At least one decision is required in the decisions array.' }, 400);
  }

  const result = submitProposalDecisions({
    workspaceId: workspace.id,
    productSku: sku,
    runId,
    sourceKind: 'catalog_product',
    decisions: parsed.data.decisions,
  });

  if (!result.ok) {
    return c.json({ error: result.reason, code: result.code }, result.code === 'decision_conflict' ? 409 : 400);
  }

  return c.json({ ok: true, decisions: result.decisions });
});

/**
 * POST /api/products/:sku/classification/runs/:runId/apply
 */
route.post('/products/:sku/classification/runs/:runId/apply', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const sku = c.req.param('sku');
  const runId = c.req.param('runId');

  const gate = validateCatalogReviewCompletionGate({
    workspaceId: workspace.id,
    productSku: sku,
    runId,
  });

  if (!gate.ok) {
    return c.json({ error: gate.reason, code: gate.code }, 400);
  }


  try {
    const result = await applyCatalogClassification(workspace.workspacePath, workspace.id, sku, runId);
    return c.json({ ok: true, ...result });
  } catch (err: any) {
    console.error(`[CatalogClassificationRoutes] Apply failed for ${sku}:`, err);
    return c.json({ error: err.message || 'Apply failed.' }, 400);
  }
});

/**
 * GET /api/products/:sku/classification/runs/:runId (P2 #19)
 * Run status/review by id. Read-only: never touches latest-run state.
 */
route.get('/products/:sku/classification/runs/:runId', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const sku = c.req.param('sku');
  const runId = c.req.param('runId');
  const run = getRun(runId);
  if (!run || run.workspaceId !== workspace.id || run.productSku !== sku || run.sourceKind !== 'catalog_product') {
    return c.json({ error: 'Run not found for this SKU and workspace.' }, 404);
  }
  return c.json({
    runId: run.id,
    sku: run.productSku,
    status: run.status,
    decisions: getLiveDecisionsByRun(run.id),
  });
});

export default route;
