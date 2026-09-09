// story: e08s01 — GET /api/onboarding/brands/strategy singleton guard
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@/db/repositories/workspace-singleton', () => ({
  getServerSingletonWorkspace: vi.fn(() => null),
  MultipleWorkspacesError: class MultipleWorkspacesError extends Error {
    workspaces: any[];
    constructor(ws: any[]) { super('multiple_workspaces'); this.workspaces = ws; }
  },
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
