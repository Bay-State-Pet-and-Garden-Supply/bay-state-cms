import { Hono } from 'hono';
import { findBatchById } from '../../db/repositories/onboarding-batch-repo';
import { findItemById } from '../../db/repositories/onboarding-item-repo';
import { findWorkspace } from '../../db/repositories/workspace-repo';
import { getCurrentItemEvidenceView } from '../../onboarding/item-evidence';

const route = new Hono();

/** Read-only accepted-evidence view; refreshing/accepting evidence is not an HTTP operation. */
route.get('/onboarding/items/:itemId/accepted-evidence', (c) => {
  const workspace = findWorkspace();
  if (!workspace) return c.json({ error: 'No active workspace loaded' }, 400);

  const item = findItemById(c.req.param('itemId'));
  const batch = item ? findBatchById(item.batchId) : null;
  if (!item || !batch || batch.workspaceId !== workspace.id) return c.json({ error: 'Item not found' }, 404);

  try {
    return c.json(getCurrentItemEvidenceView(workspace.id, item.id));
  } catch {
    return c.json({ error: 'Accepted item evidence is unavailable' }, 503);
  }
});

export default route;
