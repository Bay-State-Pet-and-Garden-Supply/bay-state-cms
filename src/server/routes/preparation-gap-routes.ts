import { Hono } from 'hono';
import {
  getPreparationGap,
  resolvePreparationGap,
} from '../../db/repositories/preparation-gap-repo';

/**
 * Spec #120 (ticket #124): durable Listing Evidence Gap correction loop.
 * Gaps are assessed post-consolidation in Prepare listing; the operator
 * correction here is attributed to the operator and never rewrites source
 * evidence. Resolution requires values for every missing field. Mutating
 * route guarded by the global API-token middleware in app.ts.
 */
export const preparationGapRoutes = new Hono();

preparationGapRoutes.get('/onboarding/preparation-gaps/:itemId', (c) => {
  const gap = getPreparationGap(c.req.param('itemId'));
  if (!gap) return c.json({ gap: null });
  return c.json({ gap });
});

preparationGapRoutes.post('/onboarding/preparation-gaps/:itemId/resolve', async (c) => {
  const body = await c.req.json().catch(() => null) as {
    correction?: Record<string, string>; resolvedBy?: string;
  } | null;
  if (!body || typeof body.correction !== 'object' || typeof body.resolvedBy !== 'string') {
    return c.json({ error: 'invalid_correction' }, 400);
  }
  try {
    const gap = resolvePreparationGap({
      itemId: c.req.param('itemId'),
      correction: body.correction,
      resolvedBy: body.resolvedBy,
    });
    return c.json({ gap });
  } catch (err) {
    if (err instanceof Error && (err as Error & { code?: string }).code === 'correction_incomplete') {
      return c.json({ error: 'correction_incomplete', message: err.message }, 422);
    }
    if (err instanceof Error && err.message === 'No preparation gap for item') {
      return c.json({ error: 'no_gap' }, 404);
    }
    throw err;
  }
});
