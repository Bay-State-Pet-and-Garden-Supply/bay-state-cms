import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import {
  createConnection,
  updateConnection,
} from '../../db/repositories/distributor-repo';
import {
  startSourcingGeneration,
  getCurrentGenerationAttempts,
  getCurrentSourcingGeneration,
} from '../../db/repositories/onboarding-evidence-repo';
import { DefaultSourcingEngine } from '../../onboarding/sourcing/engine';
import { FixedConnectorRegistry } from '../../onboarding/sourcing/connector-registry';
import type { ConnectorRegistry } from '../../onboarding/sourcing/connector-registry';
import type { DistributorConnector, SourcingLookupResult } from '../../onboarding/sourcing/contracts';

class FakeConnector implements DistributorConnector {
  readonly connectorType = 'api' as const;
  providerId: string;
  readonly requiresSecret: boolean;
  calls: Array<{ upc: string; secret: string | null; brandHint: string | null }> = [];
  constructor(
    providerId: string,
    private readonly behavior: (request: { upc: string; secret: string | null; brandHint: string | null }) => SourcingLookupResult | Promise<SourcingLookupResult>,
    private readonly throwFlag = false,
    requiresSecret = true,
  ) {
    this.providerId = providerId;
    this.requiresSecret = requiresSecret;
  }

  async lookupByGtin(request: { upc: string; gtin?: string | null; brandHint?: string | null; secret: string | null; signal: AbortSignal; deadlineAt: string }): Promise<SourcingLookupResult> {
    this.calls.push({ upc: request.upc, secret: request.secret, brandHint: request.brandHint ?? null });
    if (this.throwFlag) throw new Error('boom');
    return this.behavior({ upc: request.upc, secret: request.secret, brandHint: request.brandHint ?? null });
  }
}

function found(upc: string, brand: string): SourcingLookupResult {
  return {
    outcome: 'found',
    record: {
      matchedIdentifier: upc,
      distributorUpc: upc,
      gtin: null,
      distributorSku: null,
      name: 'Product ' + upc,
      description: null,
      brand,
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

describe('Sourcing engine (ADR 0014 provider-neutral execution)', () => {
  beforeEach(() => {
    resetDb();
    initDb(':memory:');
    runMigrations();
    // Test secrets for connections that reference env-backed secret_refs.
    process.env.PHILLIPS_KEY = 'test-phillips-key';
    process.env.UNFI_KEY = 'test-unfi-key';
    process.env.ORGILL_KEY = 'test-orgill-key';
    insertWorkspace({
      id: 'w1',
      name: 'WS',
      workspacePath: '/tmp/ws',
      gitPath: '/tmp/ws/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
  });

  afterEach(() => {
    closeDb();
  });

  async function makeItem() {
    const batch = createBatch({ workspaceId: 'w1', name: 'B', fileName: 'b.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678905', name: 'P', rowNumber: 1, stage: 'sourcing' }]);
    const gen = startSourcingGeneration(item.id, 'automatic');
    return { item, gen };
  }

  test('zero enabled connections → no attempts, no skips, no crash', async () => {
    const { item, gen } = await makeItem();
    const engine = new DefaultSourcingEngine(new FixedConnectorRegistry(null));
    const res = await engine.runGeneration({
      itemId: item.id, generationId: gen.id, workspaceId: 'w1', upc: '012345678905',
      signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30000).toISOString(),
    });
    expect(res.attempts).toEqual([]);
    expect(res.skipped).toEqual([]);
  });

  test('no normalized identifier fails closed with a skip, never a lookup', async () => {
    const { item, gen } = await makeItem();
    const connector = new FakeConnector('p1', () => found('012345678905', 'B'));
    const engine = new DefaultSourcingEngine(new FixedConnectorRegistry(connector));
    const res = await engine.runGeneration({
      itemId: item.id, generationId: gen.id, workspaceId: 'w1', upc: 'not-a-barcode',
      signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30000).toISOString(),
    });
    expect(res.skipped).toEqual([{ connectionId: '', reason: 'no_identifier' }]);
    expect(connector.calls.length).toBe(0);
  });

  test('found results persist ONE durable attempt per connection and return a summary', async () => {
    const { item, gen } = await makeItem();
    const connector = new FakeConnector('p1', () => found('012345678905', 'BrandA'));
    const conn = createConnection({ workspaceId: 'w1', distributorId: 'phillips', connectorType: 'api', secretRef: 'PHILLIPS_KEY'});
    updateConnection(conn.id, conn.workspaceId, { enabled: true });
    const engine = new DefaultSourcingEngine(new FixedConnectorRegistry(connector));
    const res = await engine.runGeneration({
      itemId: item.id, generationId: gen.id, workspaceId: 'w1', upc: '012345678905',
      signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30000).toISOString(),
    });

    expect(res.attempts.length).toBe(1);
    expect(res.attempts[0]).toMatchObject({ connectionId: expect.any(String), providerId: 'p1', outcome: 'found', matchedIdentifier: '012345678905' });
    expect(res.skipped).toEqual([]);

    const attempts = getCurrentGenerationAttempts(item.id);
    expect(attempts.length).toBe(1);
    expect(attempts[0].sourcingGenerationId).toBe(gen.id);
    expect(attempts[0].providerId).toBe('p1');
    const identity = JSON.parse(attempts[0].identityJson ?? '{}');
    expect(identity.brand).toBe('BrandA');
  });

  test('missing secret persists a DURABLE source_error attempt without invoking the connector', async () => {
    const { item, gen } = await makeItem();
    const connector = new FakeConnector('p1', () => found('012345678905', 'B'));
    const conn = createConnection({ workspaceId: 'w1', distributorId: 'phillips', connectorType: 'api', secretRef: null});
    updateConnection(conn.id, conn.workspaceId, { enabled: true });
    const engine = new DefaultSourcingEngine(new FixedConnectorRegistry(connector));
    const res = await engine.runGeneration({
      itemId: item.id, generationId: gen.id, workspaceId: 'w1', upc: '012345678905',
      signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30000).toISOString(),
    });
    expect(res.skipped).toEqual([{ connectionId: expect.any(String), reason: 'secret_missing' }]);
    expect(connector.calls.length).toBe(0);
    // ADR 0014: a missing secret is a durable bounded source_error attempt.
    const attempts = getCurrentGenerationAttempts(item.id);
    expect(attempts.length).toBe(1);
    expect(attempts[0].outcome).toBe('source_error');
    expect(attempts[0].errorCode).toBe('secret_missing');
  });

  test('public connectors (requiresSecret=false) run with secret=null even with a null secretRef', async () => {
    const { item, gen } = await makeItem();
    const connector = new FakeConnector('bradley', () => found('012345678905', 'B'), false, false);
    const conn = createConnection({ workspaceId: 'w1', distributorId: 'bradley', connectorType: 'html_scraper', secretRef: null});
    updateConnection(conn.id, conn.workspaceId, { enabled: true });
    const engine = new DefaultSourcingEngine(new FixedConnectorRegistry(connector));
    const res = await engine.runGeneration({
      itemId: item.id, generationId: gen.id, workspaceId: 'w1', upc: '012345678905',
      signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30000).toISOString(),
    });
    expect(res.skipped).toEqual([]);
    expect(res.attempts.length).toBe(1);
    expect(res.attempts[0].outcome).toBe('found');
    // The public connector was INVOKED with secret=null (no fake secret needed).
    expect(connector.calls).toEqual([{ upc: '012345678905', secret: null, brandHint: null }]);
    const attempts = getCurrentGenerationAttempts(item.id);
    expect(attempts.length).toBe(1);
    expect(attempts[0].outcome).toBe('found');
    expect(attempts[0].providerId).toBe('bradley');
  });

  test('unregistered connector types persist a durable source_error attempt with a stable reason', async () => {
    const { item, gen } = await makeItem();
    const conn = createConnection({ workspaceId: 'w1', distributorId: 'orgill', connectorType: 'ftp_catalog', secretRef: 'ORGILL_KEY'});
    updateConnection(conn.id, conn.workspaceId, { enabled: true });
    const engine = new DefaultSourcingEngine(); // real registry: ftp_catalog unregistered in v1
    const res = await engine.runGeneration({
      itemId: item.id, generationId: gen.id, workspaceId: 'w1', upc: '012345678905',
      signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30000).toISOString(),
    });
    expect(res.skipped).toEqual([{ connectionId: expect.any(String), reason: 'connector_not_registered:ftp_catalog' }]);
    expect(res.attempts).toEqual([]);
    const attempts = getCurrentGenerationAttempts(item.id);
    expect(attempts[0].errorCode).toBe('connector_not_registered');
  });

  test('masked secrets are treated as unprovisioned (durable secret_missing)', async () => {
    const { item, gen } = await makeItem();
    const connector = new FakeConnector('p1', () => found('012345678905', 'B'));
    process.env.MASKED_KEY = '•'.repeat(8) + 'abcd'; // UI-masked value
    const conn = createConnection({ workspaceId: 'w1', distributorId: 'phillips', connectorType: 'api', secretRef: 'MASKED_KEY'});
    updateConnection(conn.id, conn.workspaceId, { enabled: true });
    const engine = new DefaultSourcingEngine(new FixedConnectorRegistry(connector));
    const res = await engine.runGeneration({
      itemId: item.id, generationId: gen.id, workspaceId: 'w1', upc: '012345678905',
      signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30000).toISOString(),
    });
    expect(res.skipped).toEqual([{ connectionId: expect.any(String), reason: 'secret_missing' }]);
    expect(connector.calls.length).toBe(0);
    expect(getCurrentGenerationAttempts(item.id)[0]?.errorCode).toBe('secret_missing');
  });

  test('a found result with a mismatched identifier fails closed (identifier_mismatch)', async () => {
    const { item, gen } = await makeItem();
    // Connector claims a DIFFERENT identifier than requested.
    const connector = new FakeConnector('p1', () => found('999999999999', 'BrandA'));
    const conn = createConnection({ workspaceId: 'w1', distributorId: 'phillips', connectorType: 'api', secretRef: 'PHILLIPS_KEY'});
    updateConnection(conn.id, conn.workspaceId, { enabled: true });
    const engine = new DefaultSourcingEngine(new FixedConnectorRegistry(connector));
    await engine.runGeneration({
      itemId: item.id, generationId: gen.id, workspaceId: 'w1', upc: '012345678905',
      signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30000).toISOString(),
    });
    const attempts = getCurrentGenerationAttempts(item.id);
    expect(attempts.length).toBe(1);
    expect(attempts[0].outcome).toBe('source_error');
    expect(attempts[0].errorCode).toBe('identifier_mismatch');
  });

  test('unapproved dispatch queries all connections with no advisory table dependency', async () => {
    const { item, gen } = await makeItem();
    const seen: string[] = [];
    const connectorA = new FakeConnector('unfi', () => { seen.push('unfi'); return found('012345678905', 'B'); });
    const connectorB = new FakeConnector('phillips', () => { seen.push('phillips'); return found('012345678905', 'B'); });
    const byDistributor: ConnectorRegistry = {
      createConnector(_type, distributorId) {
        return distributorId === 'unfi' ? connectorA : distributorId === 'phillips' ? connectorB : null;
      },
    };
    const engine = new DefaultSourcingEngine(byDistributor);
    const conn = createConnection({ workspaceId: 'w1', distributorId: 'unfi', connectorType: 'api', secretRef: 'UNFI_KEY'});
    updateConnection(conn.id, conn.workspaceId, { enabled: true });
    const conn2 = createConnection({ workspaceId: 'w1', distributorId: 'phillips', connectorType: 'api', secretRef: 'PHILLIPS_KEY'});
    updateConnection(conn2.id, conn2.workspaceId, { enabled: true });
    // Query-all: every enabled connection is invoked exactly once, in
    // repository order — no preference ordering, no advisory table read.
    await engine.runGeneration({
      itemId: item.id, generationId: gen.id, workspaceId: 'w1', upc: '012345678905', brandHint: 'Nutro',
      signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30000).toISOString(),
    });
    expect(seen).toEqual(['unfi', 'phillips']);
  });

  test('engine passes explicit distributorId to the registry; no __distributorId key leaks into configuration', async () => {
    const { item, gen } = await makeItem();
    const seen: { type: string; distributorId: string; config: Record<string, unknown> }[] = [];
    const registry: ConnectorRegistry = {
      createConnector(connectorType, distributorId, configuration) {
        seen.push({ type: connectorType, distributorId, config: configuration });
        return new FakeConnector('p1', () => found('012345678905', 'B'));
      },
    };
    const engine = new DefaultSourcingEngine(registry);
    const conn = createConnection({
      workspaceId: 'w1',
      distributorId: 'phillips',
      connectorType: 'api',
      secretRef: 'PHILLIPS_KEY',
      configuration: { pageSize: 5 },
    });
    updateConnection(conn.id, conn.workspaceId, { enabled: true });

    await engine.runGeneration({
      itemId: item.id, generationId: gen.id, workspaceId: 'w1', upc: '012345678905',
      signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30000).toISOString(),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('api');
    expect(seen[0].distributorId).toBe('phillips');
    expect(seen[0].config).toEqual({ pageSize: 5 });
    expect(seen[0].config).not.toHaveProperty('__distributorId');
    expect(Object.keys(seen[0].config)).not.toContain('__distributorId');
  });

  test('attempts land in the item current generation; generation completes via repo', async () => {
    const { item, gen } = await makeItem();
    const connector = new FakeConnector('p1', () => found('012345678905', 'B'));
    const conn = createConnection({ workspaceId: 'w1', distributorId: 'phillips', connectorType: 'api', secretRef: 'PHILLIPS_KEY'});
    updateConnection(conn.id, conn.workspaceId, { enabled: true });
    const engine = new DefaultSourcingEngine(new FixedConnectorRegistry(connector));
    await engine.runGeneration({
      itemId: item.id, generationId: gen.id, workspaceId: 'w1', upc: '012345678905',
      signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30000).toISOString(),
    });
    expect(getCurrentSourcingGeneration(item.id)?.id).toBe(gen.id);
    expect(getCurrentGenerationAttempts(item.id).length).toBe(1);
  });

  test('connector throws are contained as durable source_error attempts', async () => {
    const { item, gen } = await makeItem();
    const connector = new FakeConnector('p1', () => found('012345678905', 'B'), true);
    const conn = createConnection({ workspaceId: 'w1', distributorId: 'phillips', connectorType: 'api', secretRef: 'PHILLIPS_KEY'});
    updateConnection(conn.id, conn.workspaceId, { enabled: true });
    const engine = new DefaultSourcingEngine(new FixedConnectorRegistry(connector));
    const res = await engine.runGeneration({
      itemId: item.id, generationId: gen.id, workspaceId: 'w1', upc: '012345678905',
      signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30000).toISOString(),
    });
    expect(res.attempts[0].outcome).toBe('source_error');
    const attempts = getCurrentGenerationAttempts(item.id);
    expect(attempts[0].errorCode).toBe('connector_threw');
  });

  test('unknown api distributor id is NEVER silently mapped to Phillips', async () => {
    const { item, gen } = await makeItem();
    // Real registry: 'some_distributor' is not in the Phase 1 allowlist.
    const conn = createConnection({ workspaceId: 'w1', distributorId: 'some_distributor', connectorType: 'api', secretRef: 'PHILLIPS_KEY'});
    updateConnection(conn.id, conn.workspaceId, { enabled: true });
    const engine = new DefaultSourcingEngine();
    const res = await engine.runGeneration({
      itemId: item.id, generationId: gen.id, workspaceId: 'w1', upc: '012345678905',
      signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30000).toISOString(),
    });
    expect(res.skipped).toEqual([{ connectionId: expect.any(String), reason: 'connector_not_registered:api' }]);
    expect(getCurrentGenerationAttempts(item.id)[0]?.errorCode).toBe('connector_not_registered');
  });

  test('two connections sharing one provider each get a durable attempt', async () => {
    const { item, gen } = await makeItem();
    const connector = new FakeConnector('p1', () => found('012345678905', 'B'));
    const engine = new DefaultSourcingEngine(new FixedConnectorRegistry(connector));
    const conn = createConnection({ workspaceId: 'w1', distributorId: 'phillips', connectorType: 'api', secretRef: 'PHILLIPS_KEY'});
    updateConnection(conn.id, conn.workspaceId, { enabled: true });
    const conn2 = createConnection({ workspaceId: 'w1', distributorId: 'phillips', connectorType: 'api', secretRef: 'PHILLIPS_KEY'});
    updateConnection(conn2.id, conn2.workspaceId, { enabled: true });
    await engine.runGeneration({
      itemId: item.id, generationId: gen.id, workspaceId: 'w1', upc: '012345678905',
      signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30000).toISOString(),
    });
    const attempts = getCurrentGenerationAttempts(item.id);
    expect(attempts.length).toBe(2);
    expect(new Set(attempts.map((a) => a.distributorConnectionId)).size).toBe(2);
  });

describe('Sourcing engine — identityJson merchandising persistence (Amendment B, M5)', () => {
  test('found merchandising fields persist into identityJson through the shared schema', async () => {
    const { item, gen } = await makeItem();
    const connector = new FakeConnector('phillips', () => ({
      outcome: 'found' as const,
      record: {
        matchedIdentifier: '012345678905',
        distributorUpc: '012345678905',
        gtin: null,
        distributorSku: 'SKU-9',
        name: 'Product 012345678905',
        description: 'Reviewed copy',
        brand: 'B',
        manufacturerPartNumber: 'MPN-9',
        weight: '5 lb',
        features: ['F1', 'F2'],
        category: 'Dog Food',
        dimensions: '10x10x10',
        casePack: '6',
        unitOfMeasure: 'EA',
        ingredients: 'Chicken',
        attributes: {},
        imageUrls: ['https://cdn.example.com/x.jpg'],
        sourceUrl: null,
        catalogVersion: 'v2026.3',
        observedAt: '2026-08-13T00:00:00.000Z',
        expiresAt: null,
      },
      matchedFields: ['upc', 'name'],
      warnings: [],
    }), false, false);
    const conn = createConnection({ workspaceId: 'w1', distributorId: 'phillips', connectorType: 'api' });
    updateConnection(conn.id, conn.workspaceId, { enabled: true });
    const engine = new DefaultSourcingEngine(new FixedConnectorRegistry(connector));
    await engine.runGeneration({
      itemId: item.id, generationId: gen.id, workspaceId: 'w1', upc: '012345678905',
      signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 30000).toISOString(),
    });

    const attempts = getCurrentGenerationAttempts(item.id);
    expect(attempts.length).toBe(1);
    const identity = JSON.parse(attempts[0].identityJson ?? '{}') as Record<string, unknown>;
    expect(identity.description).toBe('Reviewed copy');
    expect(identity.features).toEqual(['F1', 'F2']);
    expect(identity.category).toBe('Dog Food');
    expect(identity.dimensions).toBe('10x10x10');
    expect(identity.casePack).toBe('6');
    expect(identity.unitOfMeasure).toBe('EA');
    expect(identity.ingredients).toBe('Chicken');
    expect(identity.images).toEqual(['https://cdn.example.com/x.jpg']);
    expect(identity.distributorSku).toBe('SKU-9');
  });
});
});
