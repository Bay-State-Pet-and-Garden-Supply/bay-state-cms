/**
 * Taxonomy release status + sanctioned pin route tests (P4 — plan B.P4.3).
 *
 * Gates verified in order (fail-closed, state.json untouched on any failure):
 * 1. admin env kill switch (`BAYSTATE_CMS_RELEASE_ADMIN_ENABLED`) → 403 `release_admin_disabled`;
 * 2. API token re-check → 401 `invalid_api_token`;
 * 3. full release validation BEFORE any write (unknown revision → error, no write);
 * happy path writes pin + ISO updatedAt; GET surfaces pin/available-revision
 * status incl. manifest-hash health and the adminEnabled flag (client never guesses).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { closeDb, initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import {
  readWorkspaceState,
  writeWorkspaceState,
  workspaceStatePath,
} from '../../classification/workspace-state';
import releaseRoutes from '../../server/routes/release-routes';

let root: string;
const ENV_KEYS = ['BAYSTATE_CMS_RELEASE_ADMIN_ENABLED', 'BAYSTATE_CMS_API_TOKEN'] as const;
const savedEnv: Record<string, string | undefined> = {};

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api', releaseRoutes);
  return app;
}

function get(pathname: string): Promise<Response> {
  return Promise.resolve(makeApp().request(pathname));
}

function post(pathname: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(makeApp().request(pathname, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...headers },
  }));
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  root = fs.mkdtempSync(path.join(os.tmpdir(), `release-routes-${randomUUID().slice(0, 8)}`));
  fs.mkdirSync(path.join(root, 'store'), { recursive: true });
  initDb(path.join(root, '.shopsite-cms', 'app.db'));
  runMigrations();
  insertWorkspace({
    id: randomUUID(),
    name: 'release-route-test',
    workspacePath: root,
    gitPath: path.join(root, '.git'),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
});

afterEach(() => {
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('GET /api/settings/taxonomy-release', () => {
  it('reports null pin, defaults, admin gate off, and hash-valid available releases', async () => {
    const res = await get('/api/settings/taxonomy-release');
    expect(res.status).toBe(200);
    const payload = await res.json() as Record<string, unknown>;
    expect(payload.activeRevision).toBeNull();
    expect(payload.updatedAt).toBeNull();
    expect(payload.defaultRevision).toBe('bay-state-v3');
    expect(payload.v4Revision).toBe('bay-state-v4');
    expect(payload.adminEnabled).toBe(false);

    const revisions = payload.availableRevisions as Array<Record<string, unknown>>;
    const byId = new Map(revisions.map(r => [r.revision as string, r]));
    expect(byId.has('bay-state-v3')).toBe(true);
    expect(byId.has('bay-state-v4')).toBe(true);
    const v4 = byId.get('bay-state-v4')!;
    expect(v4.manifestHashesOk).toBe(true);
    expect(v4.errorCount).toBe(0);
    expect((v4.counts as Record<string, number>).productTypes ?? (v4.counts as Record<string, number>).types).toBeTruthy();
  });

  it('reflects an existing pin', async () => {
    writeWorkspaceState(root, { activeTaxonomyRevision: 'bay-state-v3', updatedAt: '2026-08-16T12:00:00.000Z' });
    const res = await get('/api/settings/taxonomy-release');
    const payload = await res.json() as Record<string, unknown>;
    expect(payload.activeRevision).toBe('bay-state-v3');
    expect(payload.updatedAt).toBe('2026-08-16T12:00:00.000Z');
  });
});

describe('POST /api/settings/taxonomy-release/pin gates', () => {
  it('activates the valid v5 release containing the food-form aliases through the sanctioned route', async () => {
    process.env.BAYSTATE_CMS_RELEASE_ADMIN_ENABLED = '1';
    process.env.BAYSTATE_CMS_API_TOKEN = 'fixture-release-token';
    const res = await post('/api/settings/taxonomy-release/pin', { revision: 'bay-state-v5' }, { Authorization: 'Bearer fixture-release-token' });
    expect(res.status).toBe(200);
    expect(readWorkspaceState(root)?.activeTaxonomyRevision).toBe('bay-state-v5');
    const status = await (await get('/api/settings/taxonomy-release')).json() as { availableRevisions: Array<{ revision: string; errorCount: number }> };
    expect(status.availableRevisions.find(release => release.revision === 'bay-state-v5')?.errorCount).toBe(0);
  });
  function pinFileSnapshot(): { existed: boolean; content: string | null } {
    const filePath = workspaceStatePath(root);
    if (!fs.existsSync(filePath)) return { existed: false, content: null };
    return { existed: true, content: fs.readFileSync(filePath, 'utf8') };
  }

  it('refuses without the admin env kill switch (state.json untouched)', async () => {
    process.env.BAYSTATE_CMS_API_TOKEN = 'secret-token';
    const before = pinFileSnapshot();
    const res = await post('/api/settings/taxonomy-release/pin', { revision: 'bay-state-v4' }, {
      Authorization: 'Bearer secret-token',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as Record<string, unknown>).code).toBe('release_admin_disabled');
    expect(pinFileSnapshot()).toEqual(before);
  });

  it('refuses without a matching API token even with admin env on', async () => {
    process.env.BAYSTATE_CMS_RELEASE_ADMIN_ENABLED = '1';
    process.env.BAYSTATE_CMS_API_TOKEN = 'secret-token';
    const before = pinFileSnapshot();

    const noAuth = await post('/api/settings/taxonomy-release/pin', { revision: 'bay-state-v4' });
    expect(noAuth.status).toBe(401);
    expect(((await noAuth.json()) as Record<string, unknown>).code).toBe('invalid_api_token');

    const wrongAuth = await post('/api/settings/taxonomy-release/pin', { revision: 'bay-state-v4' }, {
      Authorization: 'Bearer wrong',
    });
    expect(wrongAuth.status).toBe(401);
    expect(pinFileSnapshot()).toEqual(before);
  });

  it('refuses invalid bodies and unknown revisions before writing', async () => {
    process.env.BAYSTATE_CMS_RELEASE_ADMIN_ENABLED = '1';
    process.env.BAYSTATE_CMS_API_TOKEN = 'secret-token';
    const auth = { Authorization: 'Bearer secret-token' };
    const before = pinFileSnapshot();

    const badSlug = await post('/api/settings/taxonomy-release/pin', { revision: 'Not A Slug!' }, auth);
    expect(badSlug.status).toBe(400);

    const unknown = await post('/api/settings/taxonomy-release/pin', { revision: 'bay-state-v99' }, auth);
    expect([400, 422]).toContain(unknown.status);

    const badBody = await makeApp().request('/api/settings/taxonomy-release/pin', {
      method: 'POST',
      body: 'not-json',
      headers: { 'Content-Type': 'application/json', ...auth },
    });
    expect(badBody.status).toBe(400);
    expect(pinFileSnapshot()).toEqual(before);
  });

  it('pins bay-state-v4 after full validation passes and reflects in GET', async () => {
    process.env.BAYSTATE_CMS_RELEASE_ADMIN_ENABLED = '1';
    process.env.BAYSTATE_CMS_API_TOKEN = 'secret-token';
    const res = await post('/api/settings/taxonomy-release/pin', { revision: 'bay-state-v4' }, {
      Authorization: 'Bearer secret-token',
    });
    expect(res.status).toBe(200);
    const payload = await res.json() as Record<string, unknown>;
    expect(payload.success).toBe(true);
    expect(payload.activeRevision).toBe('bay-state-v4');
    // updatedAt is a strict ISO string (workspace-state schema enforces it).
    const stored = readWorkspaceState(root);
    expect(stored?.activeTaxonomyRevision).toBe('bay-state-v4');
    expect(new Date(stored!.updatedAt).toISOString()).toBe(stored!.updatedAt);

    const status = await (await get('/api/settings/taxonomy-release')).json() as Record<string, unknown>;
    expect(status.activeRevision).toBe('bay-state-v4');
  });

  it('supports the documented rollback path (pin back to bay-state-v3)', async () => {
    process.env.BAYSTATE_CMS_RELEASE_ADMIN_ENABLED = '1';
    process.env.BAYSTATE_CMS_API_TOKEN = 'secret-token';
    const auth = { Authorization: 'Bearer secret-token' };
    await post('/api/settings/taxonomy-release/pin', { revision: 'bay-state-v4' }, auth);
    const rollback = await post('/api/settings/taxonomy-release/pin', { revision: 'bay-state-v3' }, auth);
    expect(rollback.status).toBe(200);
    expect(readWorkspaceState(root)?.activeTaxonomyRevision).toBe('bay-state-v3');
  });
});
