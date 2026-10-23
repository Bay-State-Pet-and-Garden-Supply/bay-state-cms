/**
 * Security token route tests — env-override refusal.
 *
 * Minting a stored token while BAYSTATE_CMS_API_TOKEN is set would produce a
 * credential that can never authenticate (both gates prefer env). The route
 * must refuse loudly (409 environment_token_active) instead of minting dead
 * tokens. Without the override, generation succeeds and returns a token the
 * effective-token resolution actually honors.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { closeDb, initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import securitySettingsRoutes from '../../server/routes/security-settings-routes';

let root: string;
const savedEnv: Record<string, string | undefined> = {};

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api', securitySettingsRoutes);
  return app;
}

beforeEach(() => {
  savedEnv.BAYSTATE_CMS_API_TOKEN = process.env.BAYSTATE_CMS_API_TOKEN;
  delete process.env.BAYSTATE_CMS_API_TOKEN;
  root = fs.mkdtempSync(path.join(os.tmpdir(), `security-routes-${randomUUID().slice(0, 8)}`));
  fs.mkdirSync(path.join(root, 'store'), { recursive: true });
  initDb(path.join(root, '.shopsite-cms', 'app.db'));
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(root, { recursive: true, force: true });
  if (savedEnv.BAYSTATE_CMS_API_TOKEN === undefined) delete process.env.BAYSTATE_CMS_API_TOKEN;
  else process.env.BAYSTATE_CMS_API_TOKEN = savedEnv.BAYSTATE_CMS_API_TOKEN;
});

describe('POST /api/settings/security/token', () => {
  it('refuses with 409 when the environment token override is active', async () => {
    process.env.BAYSTATE_CMS_API_TOKEN = 'env-managed-token';
    const res = await makeApp().request('/api/settings/security/token', { method: 'POST' });
    expect(res.status).toBe(409);
    const payload = await res.json() as Record<string, unknown>;
    expect(payload.code).toBe('environment_token_active');
  });

  it('mints a usable stored token when no environment override is set', async () => {
    const res = await makeApp().request('/api/settings/security/token', { method: 'POST' });
    expect(res.status).toBe(200);
    const payload = await res.json() as { generatedToken: string; apiTokenSource: string; tokenConfigured: boolean };
    expect(typeof payload.generatedToken).toBe('string');
    expect(payload.generatedToken.length).toBeGreaterThan(16);
    expect(payload.apiTokenSource).toBe('database');
    expect(payload.tokenConfigured).toBe(true);
  });
});
