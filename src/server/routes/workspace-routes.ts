import { Hono } from 'hono';
import { getCurrentWorkspace } from '../services/workspace-service';

const route = new Hono();

/**
 * GET /api/workspace - Get store workspace metadata.
 */
route.get('/workspace', (c) => {
  const ws = getCurrentWorkspace();
  return c.json({
    workspace: ws ?? null,
    message: ws ? 'Store loaded' : 'No store loaded',
  });
});

export default route;
