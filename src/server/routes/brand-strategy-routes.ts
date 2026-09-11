// story: e08s01 — Brand Strategy aggregation projection (singleton workspace, exact normalized-brand authority)
import { Hono } from 'hono';
import { listBrandStrategies, getBrandStrategyDetail } from '../../onboarding/brand-hub/brand-strategy-service';
import { ApproveBrandStrategySchema } from '../../shared/schemas/brand-strategy';
import { requireServerSingletonWorkspace } from '../../db/repositories/workspace-singleton';
import { MultipleWorkspacesError } from '../../db/repositories/workspace-singleton';

export const brandStrategyRoutes = new Hono();

// Spec #120 (ticket #121) + builder Amendment B1: the explicit Save command.
// Every accepted Save creates one approved revision (even identical-source
// or config-only Saves); viewing/generating a proposal never writes.
// `expectedRevision` is required (0 = absent row); `expectedConfigurationToken`
// is required whenever `configuration` is present. Unknown distributor ids,
// unmapped/denylisted official domains, and duplicate refs are rejected here
// (400) — never stored inert. Stale guards fail with 409.
brandStrategyRoutes.post('/onboarding/brands/strategy/approve', async (c) => {
  try {
    const workspace = requireServerSingletonWorkspace();
    const body = await c.req.json().catch(() => null);
    const parsed = ApproveBrandStrategySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_strategy', code: 'invalid_strategy', issues: parsed.error.issues.map((i) => i.message) }, 400);
    }
    // Lazy import: keeps this route loadable without bun:sqlite (tests).
    const { saveBrandStrategy, getBrandStrategyRow } = await import('../../db/repositories/brand-strategy-approval-repo');
    try {
      const strategy = saveBrandStrategy(workspace.id, {
        brand: parsed.data.brand,
        sources: parsed.data.sources,
        expectedRevision: parsed.data.expectedRevision,
        configuration: parsed.data.configuration,
        expectedConfigurationToken: parsed.data.expectedConfigurationToken,
        approvedBy: parsed.data.approvedBy,
      });
      return c.json({ strategy });
    } catch (err) {
      const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined;
      if (code === 'stale_revision') {
        const current = getBrandStrategyRow(workspace.id, parsed.data.brand);
        return c.json({ error: 'stale_revision', code: 'stale_revision', revision: current?.revision ?? 0, message: err instanceof Error ? err.message : 'stale revision' }, 409);
      }
      if (code === 'stale_configuration') {
        const current = getBrandStrategyRow(workspace.id, parsed.data.brand);
        return c.json({ error: 'stale_configuration', code: 'stale_configuration', revision: current?.revision ?? 0, message: err instanceof Error ? err.message : 'stale configuration' }, 409);
      }
      // Semantic Save validation (duplicate/cross-kind refs, unmapped or
      // denylisted official domains, unknown distributors) throws plain
      // Errors from the repo — surface them as 400 invalid_strategy, never
      // stored, never a 500. Stale guards above keep their 409 mappings.
      if (err instanceof Error && err.message.startsWith('Invalid brand strategy approval')) {
        return c.json({ error: 'invalid_strategy', code: 'invalid_strategy', issues: [err.message] }, 400);
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof MultipleWorkspacesError) {
      return c.json({ error: 'multiple_workspaces', code: 'multiple_workspaces', workspaces: err.workspaces.map((w) => w.id), message: err.message }, 409);
    }
    throw err;
  }
});

brandStrategyRoutes.get('/onboarding/brands/strategy', (c) => {
  try {
    const brand = c.req.query('brand');
    if (brand !== undefined) {
      if (!brand.trim()) return c.json({ error: 'invalid_brand', code: 'invalid_brand', message: 'brand must be nonblank' }, 400);
      // Single-brand detail: synthesized revision-0 projection for unknown
      // brands; writes nothing (no advisory/strategy rows are created).
      const strategy = getBrandStrategyDetail(brand);
      return c.json({ strategy, strategies: strategy ? [strategy] : [] });
    }
    const strategies = listBrandStrategies();
    return c.json({ strategies });
  } catch (err) {
    if (err instanceof MultipleWorkspacesError) {
      return c.json({ error: 'multiple_workspaces', code: 'multiple_workspaces', workspaces: err.workspaces.map((w) => w.id), message: err.message }, 409);
    }
    throw err;
  }
});
