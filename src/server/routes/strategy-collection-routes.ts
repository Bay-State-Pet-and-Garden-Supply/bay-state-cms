import { Hono } from 'hono';
import { getCurrentSourcingGeneration } from '../../db/repositories/onboarding-evidence-repo';
import { getStrategyCollectionResult } from '../../db/repositories/strategy-collection-result-repo';

/**
 * Ticket #122: sanitized per-source read surface for the completed
 * strategy-collection envelope.
 *
 * Envelope fields are bounded by construction (reason codes ≤64 chars,
 * merchandising strings ≤2000, no raw error messages, no secrets), so a
 * finalized envelope is safe to return verbatim. Reads the item's CURRENT
 * sourcing generation only — historical envelopes stay generation-keyed in
 * storage and are never relabeled. Generations without a finalized envelope
 * keep their legacy interpretation (`envelope: null`, never a fallback
 * synthesis). Read-only GET, consistent with the preparation-gap reads.
 */
export const strategyCollectionRoutes = new Hono();

strategyCollectionRoutes.get('/onboarding/strategy-collections/by-item/:itemId', (c) => {
  const itemId = c.req.param('itemId');
  if (!itemId || !itemId.trim()) return c.json({ error: 'invalid_item', code: 'invalid_item' }, 400);
  let generation: { id: string } | null | undefined;
  try {
    generation = getCurrentSourcingGeneration(itemId);
  } catch {
    return c.json({ error: 'read_failed', code: 'read_failed' }, 500);
  }
  if (!generation) return c.json({ envelope: null, hash: null, generationId: null });
  try {
    const { envelope, hash } = getStrategyCollectionResult(generation.id);
    return c.json({ envelope, hash, generationId: generation.id });
  } catch (err) {
    const code = err instanceof Error ? (err as Error & { code?: string }).code ?? 'read_failed' : 'read_failed';
    if (code === 'missing_envelope') return c.json({ envelope: null, hash: null, generationId: generation.id });
    return c.json({ error: code, code, generationId: generation.id }, 422);
  }
});
