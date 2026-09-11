// story: e08s02t03 — org fanout dual-connector regression (both phillips flavors invoked, fallback gated)
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { createConnection, updateConnection } from '../../db/repositories/distributor-repo';
import { startSourcingGeneration, getCurrentGenerationAttempts } from '../../db/repositories/onboarding-evidence-repo';
import { DefaultSourcingEngine } from '../../onboarding/sourcing/engine';
import type { DistributorConnector, SourcingLookupResult } from '../../onboarding/sourcing/contracts';
import type { ConnectorRegistry } from '../../onboarding/sourcing/connector-registry';

class Fake implements DistributorConnector {
  readonly connectorType = 'api' as const;
  providerId: string;
  readonly requiresSecret: boolean;
  calls: number[] = [];
  constructor(providerId: string, private readonly result: SourcingLookupResult, requiresSecret = false) {
    this.providerId = providerId;
    this.requiresSecret = requiresSecret;
  }
  async lookupByGtin(): Promise<SourcingLookupResult> {
    this.calls.push(1);
    return this.result;
  }
}

function found(upc: string): SourcingLookupResult {
  return {
    outcome: 'found',
    record: {
      matchedIdentifier: upc,
      distributorUpc: upc,
      gtin: null,
      distributorSku: null,
      name: 'P',
      description: null,
      brand: 'TestCo',
      manufacturerPartNumber: null,
      weight: null,
      features: [],
      category: null,
      dimensions: null,
      casePack: null,
      unitOfMeasure: null,
      ingredients: null,
      attributes: {},
      imageUrls: [],
      sourceUrl: null,
      catalogVersion: null,
      observedAt: new Date().toISOString(),
      expiresAt: null,
    },
    matchedFields: ['upc'],
    warnings: [],
  };
}

function notStocked(): SourcingLookupResult {
  return { outcome: 'not_stocked' };
}

describe('Sourcing engine dual-connector org fanout (e08s02)', () => {
  beforeEach(() => {
    resetDb();
    initDb(':memory:');
    runMigrations();
    process.env.PHILLIPS_KEY = 'k';
    process.env.BRADLEY_KEY = 'k2';
    insertWorkspace({ id: 'w1', name: 'WS', workspacePath: '/tmp/ws', gitPath: '/tmp/ws/.git', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });
  });
  afterEach(() => closeDb());

  async function makeItem() {
    const batch = createBatch({ workspaceId: 'w1', name: 'B', fileName: 'b.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678905', name: 'P', rowNumber: 1, stage: 'sourcing' }]);
    const gen = startSourcingGeneration(item.id, 'automatic');
    return { item, gen };
  }

  test('both phillips connections (api + html_scraper) invoked concurrently', async () => {
    const { item, gen } = await makeItem();
    const apiConn = new Fake('phillips', found('012345678905'));
    const scrapeConn = new Fake('phillips_storefront', found('012345678905'));
    const registry: ConnectorRegistry = {
      createConnector(type: string, distributorId: string) {
        if (distributorId === 'phillips' && type === 'api') return apiConn;
        if (distributorId === 'phillips' && type === 'html_scraper') return scrapeConn;
        return null;
      },
    };
    const c1 = createConnection({ workspaceId: 'w1', distributorId: 'phillips', connectorType: 'api', secretRef: 'PHILLIPS_KEY' });
    updateConnection(c1.id, c1.workspaceId, { enabled: true });
    const c2 = createConnection({ workspaceId: 'w1', distributorId: 'phillips', connectorType: 'html_scraper', secretRef: null });
    updateConnection(c2.id, c2.workspaceId, { enabled: true });

    const engine = new DefaultSourcingEngine(registry);
    const res = await engine.runGeneration({ itemId: item.id, generationId: gen.id, workspaceId: 'w1', upc: '012345678905', brandHint: 'TestCo', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30000).toISOString() });
    expect(apiConn.calls.length).toBe(1);
    expect(scrapeConn.calls.length).toBe(1);
    expect(res.attempts.length).toBe(2);
    const attempts = getCurrentGenerationAttempts(item.id);
    expect(attempts.length).toBe(2);
  });

  test('no short-circuit: every enabled connection runs even after qualified found', async () => {
    const { item, gen } = await makeItem();
    const apiConn = new Fake('phillips', found('012345678905'));
    const scrapeConn = new Fake('phillips_storefront', found('012345678905'));
    const bradleyConn = new Fake('bradley', found('012345678905'));
    const registry: ConnectorRegistry = {
      createConnector(type: string, distributorId: string) {
        if (distributorId === 'phillips' && type === 'api') return apiConn;
        if (distributorId === 'phillips' && type === 'html_scraper') return scrapeConn;
        if (distributorId === 'bradley') return bradleyConn;
        return null;
      },
    };
    const c1 = createConnection({ workspaceId: 'w1', distributorId: 'phillips', connectorType: 'api', secretRef: 'PHILLIPS_KEY' });
    updateConnection(c1.id, c1.workspaceId, { enabled: true });
    const c2 = createConnection({ workspaceId: 'w1', distributorId: 'phillips', connectorType: 'html_scraper', secretRef: null });
    updateConnection(c2.id, c2.workspaceId, { enabled: true });
    const c3 = createConnection({ workspaceId: 'w1', distributorId: 'bradley', connectorType: 'html_scraper', secretRef: null });
    updateConnection(c3.id, c3.workspaceId, { enabled: true });

    const engine = new DefaultSourcingEngine(registry);
    const res = await engine.runGeneration({ itemId: item.id, generationId: gen.id, workspaceId: 'w1', upc: '012345678905', brandHint: 'TestCo', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30000).toISOString() });
    expect(apiConn.calls.length).toBe(1);
    expect(scrapeConn.calls.length).toBe(1);
    expect(bradleyConn.calls.length).toBe(1);
    expect(res.attempts.length).toBe(3);
    expect(res.skipped.some((s) => s.reason === 'policy_preferred_match_found')).toBe(false);
  });

  test('all connections invoked when one yields not_stocked', async () => {
    const { item, gen } = await makeItem();
    const apiConn = new Fake('phillips', notStocked());
    const bradleyConn = new Fake('bradley', found('012345678905'));
    const registry: ConnectorRegistry = {
      createConnector(_type: string, distributorId: string) {
        if (distributorId === 'phillips') return apiConn;
        if (distributorId === 'bradley') return bradleyConn;
        return null;
      },
    };
    const c1 = createConnection({ workspaceId: 'w1', distributorId: 'phillips', connectorType: 'api', secretRef: 'PHILLIPS_KEY' });
    updateConnection(c1.id, c1.workspaceId, { enabled: true });
    const c3 = createConnection({ workspaceId: 'w1', distributorId: 'bradley', connectorType: 'html_scraper', secretRef: null });
    updateConnection(c3.id, c3.workspaceId, { enabled: true });

    const engine = new DefaultSourcingEngine(registry);
    const res = await engine.runGeneration({ itemId: item.id, generationId: gen.id, workspaceId: 'w1', upc: '012345678905', brandHint: 'TestCo', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30000).toISOString() });
    expect(apiConn.calls.length).toBe(1);
    expect(bradleyConn.calls.length).toBe(1);
    expect(res.attempts.length).toBe(2);
  });
});
