// story: e08s01 — Brand Strategy aggregation projection (singleton workspace, exact normalized-brand authority)
import { Hono } from 'hono';
import { listBrandStrategies } from '../../onboarding/brand-hub/brand-strategy-service';
import { ApproveBrandStrategySchema } from '../../shared/schemas/brand-strategy';
import { requireServerSingletonWorkspace } from '../../db/repositories/workspace-singleton';
import { MultipleWorkspacesError } from '../../db/repositories/workspace-singleton';

export const brandStrategyRoutes = new Hono();

// Spec #120 (ticket #121): explicit operator approval of a reusable brand
// sourcing strategy. Viewing or generating a proposal never writes — only
// this command persists approval. Malformed source refs are rejected by
// shared Zod validation (unknown ids are stored but inert — see below);
// stale revisions fail with 409.
brandStrategyRoutes.post('/onboarding/brands/strategy/approve', async (c) => {
  try {
    const workspace = requireServerSingletonWorkspace();
    const body = await c.req.json().catch(() => null);
    const parsed = ApproveBrandStrategySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_strategy', issues: parsed.error.issues.map((i) => i.message) }, 400);
    }
    // Kind-level validation only (unknown distributor ids/domains are
    // stored but surface as setup_attention via source availability;
    // they never execute or fabricate evidence).
    // Lazy import: keeps this route loadable without bun:sqlite (tests).
    const { approveBrandStrategy, getBrandStrategyRow } = await import('../../db/repositories/brand-strategy-approval-repo');
    try {
      const strategy = approveBrandStrategy(workspace.id, {
        brand: parsed.data.brand,
        sources: parsed.data.sources,
        expectedRevision: parsed.data.expectedRevision,
        approvedBy: parsed.data.approvedBy,
      });
      return c.json({ strategy });
    } catch (err) {
      if (err instanceof Error && (err as Error & { code?: string }).code === 'stale_revision') {
        const current = getBrandStrategyRow(workspace.id, parsed.data.brand);
        return c.json({ error: 'stale_revision', revision: current?.revision ?? 0, message: err.message }, 409);
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof MultipleWorkspacesError) {
      return c.json({ error: 'multiple_workspaces', workspaces: err.workspaces.map((w) => w.id), message: err.message }, 409);
    }
    throw err;
  }
});

brandStrategyRoutes.get('/onboarding/brands/strategy', (c) => {
  try {
    const strategies = listBrandStrategies();
    return c.json({ strategies });
  } catch (err) {
    if (err instanceof MultipleWorkspacesError) {
      return c.json({ error: 'multiple_workspaces', workspaces: err.workspaces.map((w) => w.id), message: err.message }, 409);
    }
    throw err;
  }
});
