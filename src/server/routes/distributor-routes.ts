import { Hono } from 'hono';
import {
  listDistributors,
  getDistributorById,
  listConnectionsByWorkspace,
  createConnection,
  updateConnection,
} from '../../db/repositories/distributor-repo';
import { getServerSingletonWorkspace, MultipleWorkspacesError } from '../../db/repositories/workspace-singleton';
import {
  InsertDistributorConnectionSchema,
  UpdateDistributorConnectionSchema,
  type DistributorConnection,
} from '../../shared/schemas/distributor';
import { resolveSecret } from '../../onboarding/sourcing/secret-resolver';
import { connectorRequiresSecret } from '../../onboarding/sourcing/connector-registry';

const route = new Hono();

// ─── Views (ADR 0014 secret hygiene) ───────────────────────────────────────────

export interface DistributorConnectionView {
  id: string;
  distributorId: string;
  distributorName: string;
  connectorType: DistributorConnection['connectorType'];
  enabled: boolean;
  /** Boolean only — secret_ref contents and resolved secrets are NEVER returned. */
  secretConfigured: boolean;
  /**
   * Amendment B (M2): whether this connector TYPE needs a secret at all.
   * Public storefront scrapers (Bradley, Central Pet) report `false` — the
   * UI shows “no secret required” instead of a misleading “secret missing”.
   */
  secretRequired: boolean;
  configuration: Record<string, unknown>;
  authorityPolicy: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function toConnectionView(connection: DistributorConnection): DistributorConnectionView {
  const distributor = getDistributorById(connection.distributorId);
  return {
    id: connection.id,
    distributorId: connection.distributorId,
    distributorName: distributor?.name ?? connection.distributorId,
    connectorType: connection.connectorType,
    enabled: connection.enabled,
    secretConfigured: resolveSecret(connection.secretRef) !== null,
    secretRequired: connectorRequiresSecret(connection.connectorType, connection.distributorId),
    configuration: connection.configuration,
    authorityPolicy: connection.authorityPolicy,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

function requireWorkspace(): ReturnType<typeof getServerSingletonWorkspace> | null {
  try {
    return getServerSingletonWorkspace();
  } catch (err) {
    if (err instanceof MultipleWorkspacesError) throw err;
    throw err;
  }
}

// ─── Distributors ──────────────────────────────────────────────────────────────

// GET /api/onboarding/settings/distributors
route.get('/onboarding/settings/distributors', (c) => {
  let workspace;
  try {
    workspace = requireWorkspace();
  } catch (err) {
    if (err instanceof MultipleWorkspacesError) {
      return c.json({ error: 'multiple_workspaces', workspaces: err.workspaces.map((w) => w.id), message: err.message }, 409);
    }
    throw err;
  }
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }
  const distributors = listDistributors().map((d) => ({
    id: d.id,
    name: d.name,
    status: d.status,
  }));
  return c.json({ distributors });
});

// ─── Connections ───────────────────────────────────────────────────────────────

// GET /api/onboarding/settings/connections
route.get('/onboarding/settings/connections', (c) => {
  let workspace;
  try {
    workspace = requireWorkspace();
  } catch (err) {
    if (err instanceof MultipleWorkspacesError) {
      return c.json({ error: 'multiple_workspaces', workspaces: err.workspaces.map((w) => w.id), message: err.message }, 409);
    }
    throw err;
  }
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }
  const connections = listConnectionsByWorkspace(workspace.id).map(toConnectionView);
  return c.json({ connections });
});

// POST /api/onboarding/settings/connections
// Body = InsertDistributorConnectionSchema WITHOUT workspaceId — the active
// workspace is derived server-side and overrides any client-supplied value.
route.post('/onboarding/settings/connections', async (c) => {
  let workspace;
  try {
    workspace = requireWorkspace();
  } catch (err) {
    if (err instanceof MultipleWorkspacesError) {
      return c.json({ error: 'multiple_workspaces', workspaces: err.workspaces.map((w) => w.id), message: err.message }, 409);
    }
    throw err;
  }
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parse = InsertDistributorConnectionSchema.safeParse({ ...(body as object), workspaceId: workspace.id });
  if (!parse.success) {
    return c.json({ error: 'Invalid distributor connection', details: parse.error.format() }, 400);
  }

  try {
    const connection = createConnection(parse.data);
    return c.json({ connection: toConnectionView(connection) }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to create connection' }, 400);
  }
});

// PATCH /api/onboarding/settings/connections/:id
// Body = UpdateDistributorConnectionSchema; workspace-scoped (a connection id
// outside the active workspace is a 404, never a mutation).
route.patch('/onboarding/settings/connections/:id', async (c) => {
  let workspace;
  try {
    workspace = requireWorkspace();
  } catch (err) {
    if (err instanceof MultipleWorkspacesError) {
      return c.json({ error: 'multiple_workspaces', workspaces: err.workspaces.map((w) => w.id), message: err.message }, 409);
    }
    throw err;
  }
  if (!workspace) {
    return c.json({ error: 'No active workspace loaded' }, 400);
  }

  const id = c.req.param('id');
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parse = UpdateDistributorConnectionSchema.safeParse(body);
  if (!parse.success) {
    return c.json({ error: 'Invalid distributor connection update', details: parse.error.format() }, 400);
  }

  try {
    const connection = updateConnection(id, workspace.id, parse.data);
    if (!connection) {
      return c.json({ error: 'Distributor connection not found' }, 404);
    }
    return c.json({ connection: toConnectionView(connection) });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'Failed to update connection' }, 400);
  }
});

export default route;
