import { beforeEach, afterEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import embeddingRoutes from '../../server/routes/embedding-routes';

const workspaceId = 'ws-embedding-routes';

function makeApp(): Hono {
  const app = new Hono();
  app.route('/api', embeddingRoutes);
  return app;
}

beforeEach(() => {
  const workspacePath = path.join(os.tmpdir(), `embedding-routes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
  initDb(path.join(workspacePath, '.baystate-cms', 'app.db'));
  runMigrations();
  insertWorkspace({
    id: workspaceId,
    name: 'test',
    workspacePath,
    gitPath: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
});

afterEach(() => {
  closeDb();
});

describe('embedding routes — retired per ADR 0033 (410 Gone)', () => {
  it('stats endpoint returns 410 Gone', async () => {
    const app = makeApp();
    const res = await app.request('/api/embeddings/stats?model=nomic-embed-text');
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.code).toBe('feature_retired');
  });

  it('feature-policy endpoint returns 410 Gone', async () => {
    const app = makeApp();
    const res = await app.request('/api/embeddings/feature-policy');
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.code).toBe('feature_retired');
  });

  it('production rebuild returns 410 Gone', async () => {
    const app = makeApp();
    const res = await app.request('/api/embeddings/rebuild-prod', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.code).toBe('feature_retired');
  });

  it('production search returns 410 Gone', async () => {
    const app = makeApp();
    const res = await app.request('/api/embeddings/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'dog food' }),
    });
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.code).toBe('feature_retired');
  });

  it('rebuild returns 410 Gone', async () => {
    const app = makeApp();
    const res = await app.request('/api/embeddings/rebuild', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.code).toBe('feature_retired');
  });
});

describe('embedding routes — benchmark routes mounted once under /api', () => {
  it('app.ts mounts benchmarkRoutes exactly once', async () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/server/app.ts'), 'utf-8');
    const importCount = (source.match(/benchmarkRoutes/g) ?? []).length;
    const mountCount = (source.match(/app\.route\('\/api', benchmarkRoutes\)/g) ?? []).length;
    expect(importCount).toBeGreaterThanOrEqual(2); // import + mount reference
    expect(mountCount).toBe(1);
    expect(source).toContain("import benchmarkRoutes from './routes/benchmark-routes'");
  });
});
