/**
 * Distributor settings routes (ADR 0014) — server-side tests.
 *
 * DB-backed (runs under `bun test` via test:db — vitest cannot collect
 * bun:sqlite suites). Exercises the route module directly (no app-level
 * autoload middleware) so the no-active-workspace case is deterministic.
 *
 * Proves:
 * - active-workspace derivation (never a client-supplied workspaceId);
 * - secret hygiene: the connection view carries a boolean secretConfigured
 *   and NEVER exposes secret_ref contents or resolved credentials;
 * - schema-validated create/update (credential-shaped config → 400);
 * - cross-workspace mutations fail closed (404);
 * - retired advisory brand-profile routes return 404 and never mutate.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import distributorRoutes from '../../server/routes/distributor-routes';

const WS_ID = 'dist-routes-w1';
const FOREIGN_WS_ID = 'dist-routes-w2';

function workspacePayload(id: string, name: string) {
  return {
    id,
    name,
    workspacePath: `/tmp/${id}`,
    gitPath: `/tmp/${id}/.git`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete' as const,
    baselineCommit: null,
  };
}

describe('Distributor settings routes (ADR 0014)', () => {
  beforeEach(() => {
    initDb(':memory:');
    runMigrations();
    insertWorkspace(workspacePayload(WS_ID, 'Workspace One'));
  });

  test('no active workspace → 400 for every endpoint', async () => {
    // Re-initialize WITHOUT a workspace: the workspace table exists (migrations
    // ran) but has zero rows, so findWorkspace() returns null.
    initDb(':memory:');
    runMigrations();

    const getRes = await distributorRoutes.request('/onboarding/settings/connections');
    expect(getRes.status).toBe(400);
    expect((await getRes.json())?.error).toContain('No active workspace');

    const postRes = await distributorRoutes.request('/onboarding/settings/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ distributorId: 'phillips', connectorType: 'api' }),
    });
    expect(postRes.status).toBe(400);

    const patchRes = await distributorRoutes.request('/onboarding/settings/connections/conn-x', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patchRes.status).toBe(400);

    // The retired advisory surface 404s even without a workspace (the
    // route no longer exists; authenticated callers also get 404).
    const profilesRes = await distributorRoutes.request('/onboarding/settings/brand-profiles');
    expect(profilesRes.status).toBe(404);
  });

  test('GET connections returns an empty list when none exist', async () => {
    const res = await distributorRoutes.request('/onboarding/settings/connections');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ connections: [] });
  });

  test('POST creates a connection; view reports secretConfigured and NEVER leaks the secret', async () => {
    // First: no secret configured.
    const post1 = await distributorRoutes.request('/onboarding/settings/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        distributorId: 'phillips',
        connectorType: 'api',
        configuration: { baseUrl: 'https://api.endlessaisles.io/v1' },
      }),
    });
    expect(post1.status).toBe(201);
    const body1 = await post1.json();
    expect(body1.connection.secretConfigured).toBe(false);
    // Amendment B (M2): api connectors require a secret.
    expect(body1.connection.secretRequired).toBe(true);
    expect(body1.connection.distributorName).toBe('phillips');
    expect(body1.connection.configuration).toEqual({ baseUrl: 'https://api.endlessaisles.io/v1' });
    // Amendment A: creation is ALWAYS disabled — enablement is a separate
    // explicit PATCH after operator health checks.
    expect(body1.connection.enabled).toBe(false);

    // Second: a provisioned secret via env var → secretConfigured true.
    process.env.TEST_DISTRIBUTOR_KEY = 'super-secret-value-123';
    try {
      const post2 = await distributorRoutes.request('/onboarding/settings/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          distributorId: 'bci',
          connectorType: 'api',
          secretRef: 'TEST_DISTRIBUTOR_KEY',
        }),
      });
      expect(post2.status).toBe(201);
      const raw2 = await post2.text();
      const body2 = JSON.parse(raw2);
      expect(body2.connection.secretConfigured).toBe(true);
      // ADR 0014 secret hygiene: no secretRef field, no resolved credential.
      expect(Object.keys(body2.connection)).not.toContain('secretRef');
      expect(raw2).not.toContain('super-secret-value-123');
      expect(raw2).not.toContain('TEST_DISTRIBUTOR_KEY');
    } finally {
      delete process.env.TEST_DISTRIBUTOR_KEY;
    }
  });

  test('public html_scraper connections report secretRequired=false and are never presented as secretly missing', async () => {
    const post = await distributorRoutes.request('/onboarding/settings/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        distributorId: 'bradley',
        connectorType: 'html_scraper',
        secretRef: null,
      }),
    });
    expect(post.status).toBe(201);
    const body = await post.json();
    // Public storefront scraper: no secret required, creation still disabled.
    expect(body.connection.secretRequired).toBe(false);
    expect(body.connection.secretConfigured).toBe(false);
    expect(body.connection.enabled).toBe(false);
    expect(body.connection.connectorType).toBe('html_scraper');
  });

  test('all five html_scraper scraper rows create DISABLED with truthful secret status (public vs auth) and masked refs', async () => {
    const PUBLIC = ['bradley', 'central_pet'];
    const AUTH = ['orgill', 'pet_food_experts', 'phillips_storefront'];
    for (const distributorId of [...PUBLIC, ...AUTH]) {
      const post = await distributorRoutes.request('/onboarding/settings/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          distributorId,
          connectorType: 'html_scraper',
          secretRef: AUTH.includes(distributorId) ? `ops_${distributorId}_ref` : null,
        }),
      });
      expect(post.status).toBe(201);
      const body = await post.json();
      expect(body.connection.enabled).toBe(false);
      expect(body.connection.connectorType).toBe('html_scraper');
      expect(body.connection.secretRequired).toBe(AUTH.includes(distributorId));
      expect(body.connection.secretConfigured).toBe(false);
      // The view never leaks the resolved credential value or the raw ref name.
      const raw = JSON.stringify(body);
      expect(raw).not.toContain('ops_orgill_ref');
      expect(raw).not.toContain('password');
    }
    const rows = getDb().query('SELECT distributor_id, enabled FROM distributor_connections WHERE connector_type = ? AND workspace_id = ?').all('html_scraper', WS_ID) as Array<{ distributor_id: string; enabled: number }>;
    expect(rows.map((r) => r.distributor_id).sort()).toEqual([...AUTH, ...PUBLIC].sort());
    expect(rows.every((r) => r.enabled === 0)).toBe(true);
  });

  test('A client-supplied workspaceId is IGNORED (active workspace wins)', async () => {
    const post3 = await distributorRoutes.request('/onboarding/settings/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'some-other-workspace',
        distributorId: 'unfi',
        connectorType: 'api',
      }),
    });
    expect(post3.status).toBe(201);
    const body3 = await post3.json();
    const row = getDb().query('SELECT workspace_id FROM distributor_connections WHERE id = ?').get(body3.connection.id) as { workspace_id: string };
    expect(row.workspace_id).toBe(WS_ID);
  });

  test('POST with a credential-shaped configuration → 400', async () => {
    const res = await distributorRoutes.request('/onboarding/settings/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        distributorId: 'phillips',
        connectorType: 'api',
        configuration: { password: 'hunter2' },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid distributor connection');

    const count = getDb().query('SELECT COUNT(*) as cnt FROM distributor_connections').get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  test('POST with an unknown connector type → 400 (closed enum)', async () => {
    const res = await distributorRoutes.request('/onboarding/settings/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ distributorId: 'x', connectorType: 'edi_832' }),
    });
    expect(res.status).toBe(400);
  });

  test('PATCH updates enable/config and is workspace-scoped (404 cross-workspace, 400 on credential config)', async () => {
    const createRes = await distributorRoutes.request('/onboarding/settings/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ distributorId: 'phillips', connectorType: 'api' }),
    });
    const { connection } = await createRes.json();
    // Created disabled; the separate enable PATCH is the only activation path.
    expect(connection.enabled).toBe(false);

    const enableRes = await distributorRoutes.request(`/onboarding/settings/connections/${connection.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(enableRes.status).toBe(200);
    expect((await enableRes.json()).connection.enabled).toBe(true);

    const patchRes = await distributorRoutes.request(`/onboarding/settings/connections/${connection.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false, configuration: { baseUrl: 'https://api.endlessaisles.io/v2' } }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json();
    expect(patched.connection.enabled).toBe(false);
    expect(patched.connection.configuration).toEqual({ baseUrl: 'https://api.endlessaisles.io/v2' });

    // Credential-shaped update → 400.
    const badPatch = await distributorRoutes.request(`/onboarding/settings/connections/${connection.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ configuration: { apiKey: 'secret' } }),
    });
    expect(badPatch.status).toBe(400);

    // e08s03 singleton enforcement: multiple workspaces now fail-closed 409 (not cross-workspace 404).
    insertWorkspace(workspacePayload(FOREIGN_WS_ID, 'Workspace Two'));
    const { createConnection, updateConnection } = await import('../../db/repositories/distributor-repo');
    const foreignConn = createConnection({
      workspaceId: FOREIGN_WS_ID,
      distributorId: 'phillips',
      connectorType: 'api',
    });
    expect(foreignConn.enabled).toBe(false);
    updateConnection(foreignConn.id, FOREIGN_WS_ID, { enabled: true });
    const crossRes = await distributorRoutes.request(`/onboarding/settings/connections/${foreignConn.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(crossRes.status).toBe(409);
    expect((await crossRes.clone().json()).error).toContain('multiple_workspaces');
    const foreignRow = getDb().query('SELECT enabled FROM distributor_connections WHERE id = ?').get(foreignConn.id) as { enabled: number };
    expect(foreignRow.enabled).toBe(1);

    // With multiple workspaces, even a bogus id is 409 (singleton fail-closed takes precedence).
    const missingRes = await distributorRoutes.request('/onboarding/settings/connections/conn-does-not-exist', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(missingRes.status).toBe(409);
  });

  test('GET distributors reflects distributors auto-created by connections', async () => {
    await distributorRoutes.request('/onboarding/settings/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ distributorId: 'phillips', connectorType: 'api' }),
    });
    const res = await distributorRoutes.request('/onboarding/settings/distributors');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.distributors.some((d: { id: string }) => d.id === 'phillips')).toBe(true);
  });

  test('retired brand-profile routes return 404 and never mutate advisory rows', async () => {
    // GET/POST/DELETE on the removed surface 404 on the authenticated route
    // surface — never empty successful lists or successful no-op writes.
    const empty = await distributorRoutes.request('/onboarding/settings/brand-profiles');
    expect(empty.status).toBe(404);

    const postRes = await distributorRoutes.request('/onboarding/settings/brand-profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: 'Nutro', aliases: ['nutro'], preferredDistributorIds: ['phillips', 'unfi'] }),
    });
    expect(postRes.status).toBe(404);

    const delRes = await distributorRoutes.request('/onboarding/settings/brand-profiles/Nutro', { method: 'DELETE' });
    expect(delRes.status).toBe(404);

    // No advisory table exists for anything to have mutated.
    const tables = (getDb().query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).not.toContain('brand_advisory_profiles');
  });

  test('secretRef accepts only reference names — raw credential values are rejected', async () => {
    // Valid reference: an env var / api_keys service NAME. Amendment A:
    // no `enabled` on create — creation is always disabled.
    const ok = await distributorRoutes.request('/onboarding/settings/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ distributorId: 'phillips', connectorType: 'api', secretRef: 'PHILLIPS_API_KEY' }),
    });
    expect(ok.status).toBe(201);

    // Create-as-enabled shortcut is rejected (Amendment A).
    const shortcut = await distributorRoutes.request('/onboarding/settings/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ distributorId: 'phillips', connectorType: 'api', secretRef: 'PHILLIPS_API_KEY', enabled: true }),
    });
    expect(shortcut.status).toBe(400);

    // Credential-shaped values must fail validation (never stored).
    for (const bad of ['sk-live-abc123def456', 'Bearer eyJhbGciOiJIUzI1NiJ9', 'a'.repeat(32), 'secret value with spaces']) {
      const res = await distributorRoutes.request('/onboarding/settings/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ distributorId: 'phillips', connectorType: 'api', secretRef: bad }),
      });
      expect(res.status).toBe(400);
    }
  });
});

