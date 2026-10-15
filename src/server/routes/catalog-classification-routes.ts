import { Hono } from 'hono';
import { getCurrentWorkspace } from '../services/workspace-service';
import { readProductFile } from '../../git/workspace-files';
import { classifyCatalogProduct } from '../../classification/catalog-product-classifier';
import { computeProductHash } from '../../classification/catalog-product-source';
import { getDb } from '../../db/connection';
import { getRecentCatalogRun, getEvidenceByRun, getLiveDecisionsByRun, getProposalsByRun, getStageResults } from '../../db/repositories/classification-run-repo';
import { loadRuntimeConfigAuthority, createRuntimeActivationContext } from '../../classification/config-loader';
import { authorityConfigHashMatches, runtimeSnapshotHashMatchesConfig } from '../../classification/runtime-snapshot';
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
route.get('/products/:sku/classification', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const sku = c.req.param('sku');
  const run = getRecentCatalogRun(workspace.id, sku);

  if (!run) {
    return c.json({ run: null, configDrift: false, sourceDrift: false, evidence: [], proposals: [], decisions: [], stageResults: [] });
  }

  const evidence = getEvidenceByRun(run.id);
  const proposals = getProposalsByRun(run.id);
  const stageResults = getStageResults(run.id);

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
    stageResults,
  });
});

/**
 * POST /api/products/:sku/classification/runs
 * Run classification for a product SKU.
 */
route.post('/products/:sku/classification/runs', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const sku = c.req.param('sku');

  // Read product
  const product = readProductFile(workspace.workspacePath, sku);
  if (!product) return c.json({ error: `Product not found: ${sku}` }, 404);

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

  // Issue #354: shared canonical readiness (pair + profile + required values)
  // is enforced before any draft mutation — same result the review surfaces
  // report. A required gap fails attributably with no partial write.
  const readiness = evaluateCanonicalReadiness({ workspaceId: workspace.id, runId });
  if (!readiness.ok) {
    return c.json({ error: readiness.reason, code: readiness.code }, 400);
  }

  try {
    const result = await applyCatalogClassification(workspace.workspacePath, workspace.id, sku, runId);
    return c.json({ ok: true, ...result });
  } catch (err: any) {
    console.error(`[CatalogClassificationRoutes] Apply failed for ${sku}:`, err);
    return c.json({ error: err.message || 'Apply failed.' }, 400);
  }
});

export default route;
