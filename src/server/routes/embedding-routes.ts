/**
 * Embedding Routes
 *
 * Workspace-scoped endpoints for embedding statistics, REAL evaluation
 * maintenance, and policy-disabled production embedding/retrieval.
 *
 * Path conventions (mounted once under /api in app.ts):
 *   GET  /embeddings/stats
 *   POST /embeddings/rebuild        (evaluation namespace, explicit token)
 *   POST /embeddings/rebuild-prod   (always policy-disabled under the approved config)
 *   POST /embeddings/search         (production retrieval -> policy-disabled)
 *
 * Production namespaces remain disabled: the approved Bay State model policy
 * keeps every ML feature disabled, so production embedding/retrieval requests
 * fail closed with a policy-disabled response. Evaluation maintenance requires
 * an explicit evaluationRequestToken AND an evaluation-allowed feature policy.
 */

import { Hono } from 'hono';
import { getCurrentWorkspace } from '../services/workspace-service';
import * as embeddingRepo from '../../db/repositories/embedding-repo';
import * as benchmarkRepo from '../../db/repositories/benchmark-repo';
import { runEmbeddingMaintenance, EmbeddingPolicyDeniedError, EmbeddingMaintenanceLockedError } from '../../classification/embedding-maintenance';
import { findSimilarApprovedProducts, RetrievalPolicyDisabledError } from '../../classification/product-retrieval';
import { evaluateAllFeatures } from '../../classification/feature-policy';
import type { ModelPolicyConfigV2 } from '../../shared/schemas/classification';

const route = new Hono();

/** Load the active model policy from the workspace config (may be absent). */
function currentModelPolicy(): { policy: ModelPolicyConfigV2 | null; configError: string | null } {
  const workspace = getCurrentWorkspace();
  if (!workspace) return { policy: null, configError: null };
  const cfg = workspace.classificationConfig as unknown as
    | { modelPolicy?: ModelPolicyConfigV2 }
    | undefined;
  return { policy: cfg?.modelPolicy ?? null, configError: workspace.classificationConfigError ?? null };
}

function policyErrorBody(err: unknown) {
  if (err instanceof EmbeddingPolicyDeniedError) {
    return { error: err.message, code: err.code, policyDisabled: true };
  }
  if (err instanceof RetrievalPolicyDisabledError) {
    return { error: err.message, code: err.code, policyDisabled: true };
  }
  if (err instanceof EmbeddingMaintenanceLockedError) {
    return { error: err.message, code: 'maintenance_locked' };
  }
  return { error: err instanceof Error ? err.message : String(err) };
}

/**
 * GET /embeddings/stats
 * Workspace-scoped embedding statistics (production namespace by default).
 */
route.get('/embeddings/stats', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const model = c.req.query('model') || 'nomic-embed-text';
  const namespace = c.req.query('namespace') === 'evaluation' ? 'evaluation' : 'production';
  const rows = embeddingRepo.getEmbeddingsByNamespace(workspace.id, namespace, model);

  return c.json({
    totalEmbedded: rows.length,
    model,
    namespace,
    sampleSkus: rows.slice(0, 10).map(r => r.product_sku),
  });
});

/**
 * POST /embeddings/rebuild
 * Run REAL embedding maintenance for the EVALUATION namespace. Requires an
 * explicit evaluationRequestToken and an evaluation-allowed feature policy.
 */
route.post('/embeddings/rebuild', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const evaluationRequestToken = typeof body.evaluationRequestToken === 'string' ? body.evaluationRequestToken : '';
  if (!evaluationRequestToken) {
    return c.json({ error: 'Evaluation-namespace embedding maintenance requires an explicit evaluationRequestToken.', code: 'evaluation_request_token_required', policyDisabled: true }, 403);
  }

  const { policy } = currentModelPolicy();
  const verifiedReceiptDigests = benchmarkRepo.getVerifiedReceiptDigests();
  const model = typeof body.model === 'string' ? body.model : undefined;

  try {
    const report = await runEmbeddingMaintenance(workspace.id, {
      namespace: 'evaluation',
      model,
      evaluationRequestToken,
      modelPolicy: policy,
      featurePolicyOptions: { verifiedReceiptDigests },
      batchSize: typeof body.batchSize === 'number' ? body.batchSize : undefined,
      cursor: typeof body.cursor === 'string' ? body.cursor : undefined,
    });
    return c.json({ message: 'Embedding maintenance complete', ...report });
  } catch (err: unknown) {
    return c.json(policyErrorBody(err), err instanceof EmbeddingPolicyDeniedError ? 403 : 409);
  }
});

/**
 * POST /embeddings/rebuild-prod
 * Production-namespace maintenance. Under the approved configuration the
 * productionEmbeddings feature is disabled, so this ALWAYS returns a
 * policy-disabled response (fail closed).
 */
route.post('/embeddings/rebuild-prod', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const { policy, configError } = currentModelPolicy();
  if (configError) return c.json({ error: configError, policyDisabled: true }, 409);
  const verifiedReceiptDigests = benchmarkRepo.getVerifiedReceiptDigests();

  try {
    const report = await runEmbeddingMaintenance(workspace.id, {
      namespace: 'production',
      modelPolicy: policy,
      featurePolicyOptions: { verifiedReceiptDigests },
    });
    return c.json({ message: 'Embedding maintenance complete', ...report });
  } catch (err: unknown) {
    return c.json(policyErrorBody(err), err instanceof EmbeddingPolicyDeniedError ? 403 : 409);
  }
});

/**
 * POST /embeddings/search
 * Production retrieval. Under the approved configuration productionRetrieval
 * is disabled, so this returns a policy-disabled response.
 */
route.post('/embeddings/search', async (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const queryText = typeof body.query === 'string' && body.query.trim().length > 0 ? body.query : null;
  if (!queryText) return c.json({ error: 'query is required.' }, 400);

  const { policy, configError } = currentModelPolicy();
  if (configError) return c.json({ error: configError, policyDisabled: true }, 409);
  const verifiedReceiptDigests = benchmarkRepo.getVerifiedReceiptDigests();
  const scope = body.scope === 'evaluation' ? 'evaluation' : 'production';
  const evaluationRequestToken = typeof body.evaluationRequestToken === 'string' ? body.evaluationRequestToken : undefined;

  try {
    const matches = await findSimilarApprovedProducts(workspace.id, queryText, {
      model: typeof body.model === 'string' ? body.model : undefined,
      topK: typeof body.topK === 'number' ? body.topK : 5,
      minSimilarity: typeof body.minSimilarity === 'number' ? body.minSimilarity : 0.6,
      excludeSkus: Array.isArray(body.excludeSkus) ? body.excludeSkus.filter((s: unknown): s is string => typeof s === 'string') : undefined,
      scope,
      evaluationRequestToken,
      modelPolicy: policy,
      featurePolicyOptions: { verifiedReceiptDigests },
    });
    return c.json({ matches, scope });
  } catch (err: unknown) {
    return c.json(policyErrorBody(err), err instanceof RetrievalPolicyDisabledError ? 403 : 409);
  }
});

/**
 * GET /embeddings/feature-policy
 * Report the current evaluation of every ML feature for the workspace.
 */
route.get('/embeddings/feature-policy', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) return c.json({ error: 'No workspace loaded.' }, 400);
  const { policy, configError } = currentModelPolicy();
  if (!policy) {
    return c.json({ features: {}, configError, note: 'No model policy configured; every feature fails closed.' });
  }
  const verifiedReceiptDigests = benchmarkRepo.getVerifiedReceiptDigests();
  const decisions = evaluateAllFeatures(policy, 'production', { verifiedReceiptDigests });
  return c.json({ features: decisions });
});

export default route;
