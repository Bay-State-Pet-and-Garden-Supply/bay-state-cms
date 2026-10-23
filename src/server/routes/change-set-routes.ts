import { Hono } from 'hono';
import { getCurrentWorkspace } from '../services/workspace-service';
import {
  listWorkspaceChangeSets, getChangeSetDetail,
  approveChangeSet, discardChangeSet,
} from '../services/change-set-service';
import { validateChangeSet } from '../../validation/change-set-validation';

const route = new Hono();

/**
 * GET /api/change-sets - List change sets.
 */
route.get('/change-sets', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const changeSets = listWorkspaceChangeSets(workspace.id);
  return c.json({ changeSets });
});

/**
 * GET /api/change-sets/:id - Get change set details with items.
 */
route.get('/change-sets/:id', (c) => {
  const id = c.req.param('id');
  const { changeSet, items, linkedManifest, linkedStatus, linkedComplete } = getChangeSetDetail(id);
  if (!changeSet) {
    return c.json({ error: 'Change set not found' }, 404);
  }
  return c.json({ changeSet, items, linkedManifest, linkedStatus, linkedComplete });
});

/**
 * POST /api/change-sets/:id/validate - Run validation.
 */
route.post('/change-sets/:id/validate', (c) => {
  const id = c.req.param('id');
  const validationR = validateChangeSet(id);
  return c.json(validationR);
});

/**
 * POST /api/change-sets/:id/approve - Approve and commit change set.
 */
route.post('/change-sets/:id/approve', (c) => {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    return c.json({ error: 'No workspace loaded.' }, 400);
  }

  const id = c.req.param('id');
  const result = approveChangeSet(id, workspace.workspacePath);

  if (result.success) {
    return c.json({
      success: true,
      commitHash: result.commitHash,
      errors: result.errors,
      ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    });
  }

  const incomplete = result.errors.some((e) => /incomplete|retry recovery|export stays blocked/i.test(e));
  return c.json({
    success: false,
    error: result.errors.join('; '),
    errors: result.errors,
    ...(incomplete ? { incomplete: true } : {}),
  }, incomplete ? 409 : (result.errors.length > 0 ? 400 : 500));
});

/**
 * POST /api/change-sets/:id/discard - Discard draft change set.
 */
route.post('/change-sets/:id/discard', (c) => {
  const id = c.req.param('id');
  const discarded = discardChangeSet(id);
  if (!discarded.success) {
    return c.json({ error: 'Change set not found' }, 404);
  }
  return c.json({ success: true, reopenedDrift: discarded.reopenedDrift });
});

export default route;
