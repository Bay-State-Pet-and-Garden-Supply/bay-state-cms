import { Hono } from 'hono';
import { z } from 'zod';
import { derivePrincipal } from '../authenticated-principal';
import { requireServerSingletonWorkspace } from '../../db/repositories/workspace-singleton';
import { loadItemListingReadiness } from '../../classification/item-listing-readiness';
import { appendListingCompletenessDecision, findListingCompletenessDecisionByActionToken, listListingCompletenessExceptions } from '../../db/repositories/listing-completeness-exception-repo';
import { applyListingStandard, listListingStandards, previewListingStandard } from '../../onboarding/listing-standards';
import { ListingRequirementSchema } from '../../shared/schemas/item-evidence';

export const listingCompletenessRoutes = new Hono();
const StandardInput = z.object({ standardId: z.string().min(1), categoryId: z.string().min(1), productTypeId: z.string().min(1), requirements: z.array(ListingRequirementSchema).min(1).max(64) }).strict();
const DecisionInput = z.object({ decision: z.enum(['approved', 'revoked']), requirementId: z.string().min(1), reason: z.string().trim().min(1).max(2000), expectedRevision: z.number().int().nonnegative(), inputHash: z.string().min(1), evidenceHash: z.string().min(1), standardHash: z.string().min(1), classificationHash: z.string().min(1), dependencyHash: z.string().min(1) }).strict();

function principal(c: { req: { header(name: string): string | undefined } }) { return derivePrincipal(c); }
function workspace(c: { json(body: unknown, status?: 400 | 401 | 403 | 404 | 409 | 422 | 503): Response }) {
  try { return { workspace: requireServerSingletonWorkspace(), response: null }; }
  catch { return { workspace: null, response: c.json({ code: 'workspace_unavailable' }, 503) }; }
}

listingCompletenessRoutes.get('/onboarding/items/:itemId/listing-readiness', (c) => {
  const scope = workspace(c);
  if (!scope.workspace) return scope.response!;
  const result = loadItemListingReadiness(scope.workspace.id, c.req.param('itemId'));
  try { return c.json({ ...result, exceptions: listListingCompletenessExceptions(scope.workspace.id, c.req.param('itemId')) }); }
  catch { return c.json({ code: 'listing_exceptions_unavailable' }, 503); }
});

listingCompletenessRoutes.get('/onboarding/listing-standards', (c) => {
  const scope = workspace(c);
  if (!scope.workspace) return scope.response!;
  try { return c.json(listListingStandards(scope.workspace.workspacePath)); }
  catch { return c.json({ code: 'listing_standards_unavailable' }, 503); }
});

listingCompletenessRoutes.post('/onboarding/listing-standards/preview', async (c) => {
  const user = principal(c);
  if (!user) return c.json({ code: 'unauthorized' }, 401);
  if (user.role !== 'catalog_approver') return c.json({ code: 'forbidden' }, 403);
  const scope = workspace(c);
  if (!scope.workspace) return scope.response!;
  const body = StandardInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ code: 'invalid_standard' }, 400);
  try { return c.json(previewListingStandard({ ...body.data, workspacePath: scope.workspace.workspacePath, actor: user.actor })); }
  catch { return c.json({ code: 'invalid_standard' }, 422); }
});

listingCompletenessRoutes.post('/onboarding/listing-standards/apply', async (c) => {
  const user = principal(c);
  if (!user) return c.json({ code: 'unauthorized' }, 401);
  if (user.role !== 'catalog_approver') return c.json({ code: 'forbidden' }, 403);
  const scope = workspace(c);
  if (!scope.workspace) return scope.response!;
  const body = z.object({ ...StandardInput.shape, expectedDocumentHash: z.string().nullable(), expectedBundleHash: z.string().min(1) }).strict().safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ code: 'invalid_standard' }, 400);
  try {
    return c.json(await applyListingStandard({ ...body.data, workspacePath: scope.workspace.workspacePath, actor: user.actor }));
  } catch { return c.json({ code: 'listing_standards_conflict' }, 409); }
});

listingCompletenessRoutes.post('/onboarding/items/:itemId/listing-exceptions', async (c) => {
  const user = principal(c);
  if (!user) return c.json({ code: 'unauthorized' }, 401);
  if (user.role !== 'catalog_approver') return c.json({ code: 'forbidden' }, 403);
  const idempotencyKey = c.req.header('Idempotency-Key')?.trim();
  if (!idempotencyKey || idempotencyKey.length > 128) return c.json({ code: 'idempotency_key_required' }, 400);
  const body = DecisionInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ code: 'invalid_decision' }, 400);
  const scope = workspace(c);
  if (!scope.workspace) return scope.response!;
  const itemId = c.req.param('itemId');
  try {
    const replay = findListingCompletenessDecisionByActionToken(scope.workspace.id, itemId, idempotencyKey);
    if (replay) {
      const result = appendListingCompletenessDecision({
        workspaceId: scope.workspace.id, itemId, sku: replay.sku, requirementId: body.data.requirementId,
        standardId: replay.standardId, standardHash: body.data.standardHash,
        classificationHash: body.data.classificationHash, inputHash: body.data.inputHash,
        dependencyHash: body.data.dependencyHash, decision: body.data.decision,
        reason: body.data.reason, actor: user.actor, actionToken: idempotencyKey,
        expectedRevision: body.data.expectedRevision,
      });
      if (result.status !== 'replayed') return c.json({ code: 'listing_completeness_stale' }, 409);
      return c.json({ ...result, evaluation: loadItemListingReadiness(scope.workspace.id, itemId).evaluation });
    }
  } catch { return c.json({ code: 'listing_completeness_stale' }, 409); }
  const live = loadItemListingReadiness(scope.workspace.id, itemId);
  const evaluation = live.evaluation;
  const requirement = evaluation.requirements.find(candidate => candidate.requirementId === body.data.requirementId);
  if (!live.standard || !live.evidence || !requirement || !requirement.dependencyHash || !evaluation.inputHash || !evaluation.classificationHash) {
    return c.json({ code: 'listing_completeness_unavailable' }, 409);
  }
  if (body.data.inputHash !== evaluation.inputHash || body.data.evidenceHash !== evaluation.evidenceHash || body.data.standardHash !== evaluation.standardHash ||
      body.data.classificationHash !== evaluation.classificationHash || body.data.dependencyHash !== requirement.dependencyHash) {
    return c.json({ code: 'listing_completeness_stale', evaluation }, 409);
  }
  const policy = live.standard.requirements.find(candidate => candidate.id === requirement.requirementId);
  const hardFields = new Set(['sku', 'upc', 'variant', 'variant_key', 'category', 'category_id', 'product_type', 'product_type_id', 'image_rights', 'safety']);
  const hardFieldPattern = /identity|(^|[^a-z])(sku|upc|gtin|variant|category|product.?type|safety|rights|licen[cs]e)([^a-z]|$)/i;
  if (body.data.decision === 'approved' && (!requirement.required || !requirement.exceptionEligible ||
      !['missing', 'stale'].includes(requirement.state) || hardFields.has(requirement.field.toLocaleLowerCase()) ||
      hardFieldPattern.test(requirement.field) || live.nonWaivableFields.includes(requirement.field) ||
      ['identity', 'image_rights', 'safety', 'classification'].includes(policy?.kind ?? ''))) {
    return c.json({ code: 'exception_not_allowed' }, 422);
  }
  if (body.data.decision === 'revoked' && requirement.state !== 'excepted' && requirement.state !== 'stale') return c.json({ code: 'exception_not_current' }, 409);
  const expectedRevision = (() => {
    try { return listListingCompletenessExceptions(scope.workspace.id, itemId).reduce((max, receipt) => Math.max(max, receipt.revision), 0); }
    catch { return null; }
  })();
  if (expectedRevision === null) return c.json({ code: 'listing_exceptions_unavailable' }, 503);
  if (expectedRevision !== body.data.expectedRevision) return c.json({ code: 'listing_completeness_stale', evaluation }, 409);
  try {
    const result = appendListingCompletenessDecision({
      workspaceId: scope.workspace.id, itemId, sku: live.evidence.sku,
      requirementId: requirement.requirementId, standardId: live.standard.id,
      standardHash: evaluation.standardHash!, classificationHash: evaluation.classificationHash!,
      inputHash: evaluation.inputHash!, dependencyHash: requirement.dependencyHash,
      decision: body.data.decision, reason: body.data.reason, actor: user.actor,
      actionToken: idempotencyKey, expectedRevision,
    });
    if (result.status === 'conflict') return c.json({ code: 'listing_completeness_stale', evaluation }, 409);
    return c.json({ ...result, evaluation: loadItemListingReadiness(scope.workspace.id, itemId).evaluation });
  } catch { return c.json({ code: 'listing_completeness_stale', evaluation }, 409); }
});
