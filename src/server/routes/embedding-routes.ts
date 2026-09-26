/**
 * Embedding Routes (Retired per Issue #312 / ADR 0033)
 *
 * Workspace-scoped endpoints for embedding statistics and vector retrieval have
 * been retired following consolidation on TypeSafe Jev. Endpoints return 410 Gone.
 */

import { Hono } from 'hono';

const route = new Hono();

const RETIRED_RESPONSE = {
  error: 'Embedding and vector retrieval endpoints have been retired per issue #312 / ADR 0033.',
  code: 'feature_retired',
};

route.get('/embeddings/stats', (c) => c.json(RETIRED_RESPONSE, 410));
route.post('/embeddings/rebuild', (c) => c.json(RETIRED_RESPONSE, 410));
route.post('/embeddings/rebuild-prod', (c) => c.json(RETIRED_RESPONSE, 410));
route.post('/embeddings/search', (c) => c.json(RETIRED_RESPONSE, 410));
route.get('/embeddings/feature-policy', (c) => c.json(RETIRED_RESPONSE, 410));

export default route;

