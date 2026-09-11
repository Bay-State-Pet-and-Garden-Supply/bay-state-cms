import { Hono } from 'hono';
import {
  getPreparationGap,
  listGapsByBatch,
} from '../../db/repositories/preparation-gap-repo';
import { recordCorrectionAndResume } from '../../onboarding/gap-correction-service';
import { derivePrincipal } from '../../server/authenticated-principal';
import { requireServerSingletonWorkspace } from '../../db/repositories/workspace-singleton';

/**
 * Spec #120 (ticket #124): durable Listing Evidence Gap correction loop.
 *
 * Gaps are assessed post-consolidation in Prepare listing. Operator
 * corrections are attributed (derived principal, never a client-supplied
 * identity), replay-safe (Idempotency-Key + command hash receipts), and
 * stale-rejecting (expected evidence binding / gap timestamp). Recording a
 * correction resumes preparation from retained evidence — the gap itself
 * clears only when re-preparation validation succeeds, never on submit.
 * Mutating routes require the global API-token principal (401 otherwise).
 */
export const preparationGapRoutes = new Hono();

preparationGapRoutes.get('/onboarding/preparation-gaps/:itemId', (c) => {
  const gap = getPreparationGap(c.req.param('itemId'));
  if (!gap) return c.json({ gap: null });
  return c.json({ gap });
});

preparationGapRoutes.get('/onboarding/preparation-gaps', (c) => {
  const batchId = c.req.query('batchId');
  if (!batchId) return c.json({ error: 'batchId is required' }, 400);
  return c.json({ gaps: listGapsByBatch(batchId) });
});

function derivePrincipalOrNull(c: {
  req: { header: (name: string) => string | undefined };
}): { actor: string; role: 'catalog_approver' | 'catalog_exporter' | 'operator' | 'system'; tokenHash: string | null } | null {
  return derivePrincipal(c);
}

async function handleCorrectAndResume(c: {
  req: {
    param: (name: string) => string;
    json: () => Promise<unknown>;
    header: (name: string) => string | undefined;
  };
  json: (body: unknown, status?: 400 | 401 | 404 | 409 | 422 | 503) => Response;
}): Promise<Response> {
  const principal = derivePrincipalOrNull(c);
  if (!principal) return c.json({ error: 'unauthorized', code: 'unauthorized' }, 401);
  const body = await c.req.json().catch(() => null) as {
    values?: Record<string, unknown>;
    expectedEvidenceHash?: string | null;
    expectedUpdatedAt?: string | null;
  } | null;
  if (!body || typeof body.values !== 'object' || body.values === null) {
    return c.json({ error: 'invalid_correction', code: 'invalid_correction' }, 400);
  }
  const idempotencyKey = c.req.header('Idempotency-Key') ?? c.req.header('idempotency-key') ?? '';
  if (!idempotencyKey.trim()) {
    return c.json({ error: 'idempotency_key_required', code: 'idempotency_key_required' }, 400);
  }
  let workspaceId: string;
  try {
    workspaceId = requireServerSingletonWorkspace().id;
  } catch {
    return c.json({ error: 'workspace_unavailable', code: 'workspace_unavailable' }, 503);
  }
  const result = recordCorrectionAndResume(
    {
      workspaceId,
      itemId: c.req.param('itemId'),
      values: body.values,
      expectedEvidenceHash: body.expectedEvidenceHash,
      expectedUpdatedAt: body.expectedUpdatedAt,
      idempotencyKey: idempotencyKey.trim(),
    },
    principal,
  );
  if (!result.ok) {
    const status = result.status as 400 | 401 | 404 | 409 | 422 | 503;
    return c.json({ error: result.code, code: result.code, message: result.message }, status);
  }
  return c.json({ gap: result.gap, envelope: result.envelope, receiptId: result.receipt.id, replay: result.replay });
}

// Ticket #124: submit a correction and resume preparation. The gap clears
// only after re-preparation validation succeeds (async, via the worker) —
// submit alone never marks the product complete.
preparationGapRoutes.post('/onboarding/preparation-gaps/:itemId/correct', handleCorrectAndResume);

// Legacy direct-resolve path: closed as a bypass — it now delegates to
// precisely the same validated correct-and-resume workflow (derived actor,
// stale rejection, idempotent receipt, validation-gated clearing).
preparationGapRoutes.post('/onboarding/preparation-gaps/:itemId/resolve', async (c) => {
  const body = await c.req.json().catch(() => null) as {
    correction?: Record<string, unknown>;
    expectedEvidenceHash?: string | null;
    expectedUpdatedAt?: string | null;
  } | null;
  if (body && typeof body.correction === 'object' && body.correction !== null) {
    // Ticket #124 P1-4: the legacy shape forwards the caller's stale
    // bindings (when supplied) so the delegated workflow enforces the
    // same stale rejection as the canonical /correct path.
    type HandlerInput = Parameters<typeof handleCorrectAndResume>[0];
    const delegated: HandlerInput = {
      req: {
        param: (name: string): string => c.req.param(name) ?? '',
        json: async (): Promise<unknown> => ({
          values: body.correction,
          expectedEvidenceHash: body.expectedEvidenceHash,
          expectedUpdatedAt: body.expectedUpdatedAt,
        }),
        header: (name: string): string | undefined => c.req.header(name) ?? undefined,
      },
      json: (responseBody: unknown, status?: 400 | 401 | 404 | 409 | 422 | 503): Response =>
        (status === undefined ? c.json(responseBody) : c.json(responseBody, status)),
    };
    return handleCorrectAndResume(delegated);
  }
  return c.json({ error: 'invalid_correction', code: 'invalid_correction' }, 400);
});
