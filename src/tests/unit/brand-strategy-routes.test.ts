// story: e08s01 — GET /api/onboarding/brands/strategy singleton guard
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@/db/repositories/workspace-singleton', () => ({
  getServerSingletonWorkspace: vi.fn(() => null),
  requireServerSingletonWorkspace: vi.fn(() => ({ id: 'ws-test' })),
  MultipleWorkspacesError: class MultipleWorkspacesError extends Error {
    workspaces: any[];
    constructor(ws: any[]) { super('multiple_workspaces'); this.workspaces = ws; }
  },
}));

// Lazy dynamic import inside the approve handler resolves to this mock,
// keeping the route test free of bun:sqlite.
vi.mock('@/db/repositories/brand-strategy-approval-repo', () => ({
  approveBrandStrategy: vi.fn(),
  getBrandStrategyRow: vi.fn(() => null),
}));

vi.mock('@/onboarding/brand-hub/brand-strategy-service', () => ({
  listBrandStrategies: vi.fn(() => [{ brandKey: 'fromm', normalizedBrand: 'fromm', aliases: [], preferredDistributorIds: [], sourcingPolicy: 'advisory', fallbackTier: [], officialDomains: [], extractorReadiness: 'not_configured', ambiguous: [], unmatched: false, possibleMatches: [] }]),
}));

import { brandStrategyRoutes } from '../../server/routes/brand-strategy-routes';

function makeApp() {
  const app = new Hono();
  app.route('/api', brandStrategyRoutes);
  return app;
}

describe('brandStrategyRoutes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /onboarding/brands/strategy returns strategies array', async () => {
    const app = makeApp();
    const res = await app.request('/api/onboarding/brands/strategy');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(Array.isArray(body.strategies)).toBe(true);
    expect(body.strategies[0].brandKey).toBe('fromm');
  });

  it('POST approve persists and returns the strategy', async () => {
    const repo = await import('../../db/repositories/brand-strategy-approval-repo');
    (repo.approveBrandStrategy as any).mockImplementation((_ws: string, input: any) => ({
      id: 'bss_1', workspaceId: 'ws-test', brand: input.brand, normalizedBrand: 'acana',
      sources: input.sources, revision: 1, approved: true, approvedAt: '2026-01-01',
      approvedBy: null, createdAt: '2026-01-01', updatedAt: '2026-01-01',
    }));
    const app = makeApp();
    const res = await app.request('/api/onboarding/brands/strategy/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brand: 'Acana',
        sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }],
        expectedRevision: 0,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.strategy.revision).toBe(1);
    expect(repo.approveBrandStrategy as any).toHaveBeenCalledWith('ws-test', expect.objectContaining({
      brand: 'Acana',
      expectedRevision: 0,
    }));
  });

  it('POST approve rejects malformed bodies with 400', async () => {
    const app = makeApp();
    const res = await app.request('/api/onboarding/brands/strategy/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: 'Acana', sources: [] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('invalid_strategy');
  });

  it('POST approve maps stale_revision to 409 with the current revision', async () => {
    const repo = await import('../../db/repositories/brand-strategy-approval-repo');
    const stale = new Error('stale_revision: expected 99, stored 2') as Error & { code: string };
    stale.code = 'stale_revision';
    (repo.approveBrandStrategy as any).mockImplementation(() => { throw stale; });
    (repo.getBrandStrategyRow as any).mockImplementation(() => ({ revision: 2 }));
    const app = makeApp();
    const res = await app.request('/api/onboarding/brands/strategy/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brand: 'Acana',
        sources: [{ kind: 'distributor_record', distributorId: 'dist_bci' }],
        expectedRevision: 99,
      }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toBe('stale_revision');
    expect(body.revision).toBe(2);
  });

  it('returns 409 on multiple_workspaces', async () => {
    const wsMod = await import('../../db/repositories/workspace-singleton');
    const err = new (wsMod.MultipleWorkspacesError as any)([{ id: 'ws1' }, { id: 'ws2' }]);
    const svc = await import('../../onboarding/brand-hub/brand-strategy-service');
    (svc.listBrandStrategies as any).mockImplementation(() => { throw err; });
    const app = makeApp();
    const res = await app.request('/api/onboarding/brands/strategy');
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toBe('multiple_workspaces');
    // restore
    (svc.listBrandStrategies as any).mockImplementation(() => []);
  });
});
