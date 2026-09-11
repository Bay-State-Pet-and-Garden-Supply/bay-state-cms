import { describe, it, expect, beforeEach } from 'vitest';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import {
  createDistributor,
  createConnection,
  updateConnection,
} from '../../db/repositories/distributor-repo';
import { startSourcingGeneration } from '../../db/repositories/onboarding-evidence-repo';
import { DefaultSourcingEngine } from '../../onboarding/sourcing/engine';
import type { ConnectorRegistry } from '../../onboarding/sourcing/connector-registry';
import type { DistributorConnector, SourcingLookupRequest, SourcingLookupResult } from '../../onboarding/sourcing/contracts';

/**
 * Issue #150 (Amendment B1.1) — query-all retirement contract.
 *
 * New unapproved/no-brand collection generations always query all enabled
 * workspace connections: no preferred ordering, no preferred-only filter,
 * no success short-circuit. The retired `preferred_only` spend-control knob
 * and `preferred_then_fallback` early stop are gone; this suite asserts the
 * declared replacement rule, including former-policy counterexamples.
 */
class MockConnector implements DistributorConnector {
  readonly connectorType = 'api';
  readonly requiresSecret = false;
  readonly providerId: string;
  lookups = 0;

  constructor(
    readonly distributorId: string,
    private readonly outcome: 'found' | 'not_stocked',
  ) {
    this.providerId = `provider_${distributorId}`;
  }

  async lookupByGtin(request: SourcingLookupRequest): Promise<SourcingLookupResult> {
    this.lookups += 1;
    if (this.outcome === 'found') {
      return {
        outcome: 'found',
        record: {
          matchedIdentifier: request.upc,
          distributorUpc: request.upc,
          gtin: request.upc,
          distributorSku: `SKU_${this.distributorId}`,
          name: `Found Product ${this.distributorId}`,
          description: 'A great pet product',
          brand: 'Acana',
          manufacturerPartNumber: null,
          weight: '25lb',
          features: ['Grain Free'],
          category: 'Dog Food',
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
        matchedFields: ['upc', 'brand'],
        warnings: [],
      };
    }
    return {
      outcome: 'not_stocked',
    };
  }
}

class TestConnectorRegistry implements ConnectorRegistry {
  private connectors = new Map<string, DistributorConnector>();

  register(distributorId: string, connector: DistributorConnector) {
    this.connectors.set(distributorId, connector);
  }

  createConnector(type: string, distributorId: string): DistributorConnector | null {
    return this.connectors.get(distributorId) ?? null;
  }
}

describe('Sourcing Engine query-all routing (issue #150)', () => {
  const workspaceId = 'ws-sourcing-test';
  let batchId: string;
  let registry: TestConnectorRegistry;

  beforeEach(() => {
    initDb(':memory:');
    runMigrations();
    insertWorkspace({
      id: workspaceId,
      name: 'Test Sourcing WS',
      workspacePath: '/tmp/test-sourcing-ws',
      gitPath: '/tmp/test-sourcing-ws/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    insertWorkspace({
      id: 'ws-foreign',
      name: 'Foreign WS',
      workspacePath: '/tmp/test-foreign-ws',
      gitPath: '/tmp/test-foreign-ws/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });

    const b = createBatch({
      workspaceId,
      name: 'Sourcing Batch',
      fileName: 'sourcing.csv',
      totalItems: 1,
    });
    batchId = b.id;

    registry = new TestConnectorRegistry();

    // Three enabled distributors; phillips has TWO transports (connections).
    createDistributor({ id: 'dist_phillips', name: 'Phillips Pet' });
    const cp = createConnection({
      id: 'conn_phillips',
      workspaceId,
      distributorId: 'dist_phillips',
      connectorType: 'api',
      configuration: {},
    });
    updateConnection(cp.id, workspaceId, { enabled: true });
    const cp2 = createConnection({
      id: 'conn_phillips_2',
      workspaceId,
      distributorId: 'dist_phillips',
      connectorType: 'api',
      configuration: {},
    });
    updateConnection(cp2.id, workspaceId, { enabled: true });

    createDistributor({ id: 'dist_bradley', name: 'Bradley Caldwell' });
    const cb = createConnection({
      id: 'conn_bradley',
      workspaceId,
      distributorId: 'dist_bradley',
      connectorType: 'api',
      configuration: {},
    });
    updateConnection(cb.id, workspaceId, { enabled: true });

    // Disabled same-workspace connection: never invoked.
    createDistributor({ id: 'dist_disabled', name: 'Disabled Co' });
    createConnection({
      id: 'conn_disabled',
      workspaceId,
      distributorId: 'dist_disabled',
      connectorType: 'api',
      configuration: {},
    });

    // Foreign-workspace connection: never invoked.
    createDistributor({ id: 'dist_foreign', name: 'Foreign Co' });
    createConnection({
      id: 'conn_foreign',
      workspaceId: 'ws-foreign',
      distributorId: 'dist_foreign',
      connectorType: 'api',
      configuration: {},
    });
    updateConnection('conn_foreign', 'ws-foreign', { enabled: true });
  });

  function runFor(itemId: string, upc: string, brandHint: string | null) {
    const generation = startSourcingGeneration(itemId);
    const engine = new DefaultSourcingEngine(registry, 2);
    return engine.runGeneration({
      itemId,
      generationId: generation.id,
      workspaceId,
      upc,
      brandHint,
      signal: new AbortController().signal,
      deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });
  }

  it('no-brand generations query every enabled connection once, including both transports', async () => {
    const phillips = new MockConnector('dist_phillips', 'found');
    const bradley = new MockConnector('dist_bradley', 'found');
    registry.register('dist_phillips', phillips);
    registry.register('dist_bradley', bradley);
    registry.register('dist_disabled', new MockConnector('dist_disabled', 'found'));
    registry.register('dist_foreign', new MockConnector('dist_foreign', 'found'));

    const items = insertItems(
      batchId,
      [{ upc: '064992524258', name: 'Unknown Product', rowNumber: 1 }],
      'sourcing',
      1,
    );
    const result = await runFor(items[0].id, '064992524258', null);

    // conn_phillips + conn_phillips_2 + conn_bradley; disabled/foreign never run.
    expect(result.attempts).toHaveLength(3);
    expect(phillips.lookups).toBe(2);
    expect(bradley.lookups).toBe(1);
    expect(result.skipped.map((s) => s.reason)).not.toContain('policy_preferred_only');
    expect(result.skipped.map((s) => s.reason)).not.toContain('policy_preferred_match_found');
  });

  it('unknown, whitespace, and former-preference brand hints all get the same rule', async () => {
    const phillips = new MockConnector('dist_phillips', 'found');
    const bradley = new MockConnector('dist_bradley', 'found');
    registry.register('dist_phillips', phillips);
    registry.register('dist_bradley', bradley);

    for (const hint of ['ACANA', '   ', 'NoSuchBrand', 'LegacyPreferred']) {
      const items = insertItems(
        batchId,
        [{ upc: '064992524258', name: `Product ${hint}`, brandHint: hint, rowNumber: 1 }],
        'sourcing',
        1,
      );
      const before = phillips.lookups;
      const result = await runFor(items[0].id, '064992524258', hint);
      // No approval is ever inferred from a former preference: all enabled run.
      expect(result.attempts).toHaveLength(3);
      expect(phillips.lookups - before).toBe(2);
    }
  });

  it('a first qualified found never suppresses another connection; failure never alters eligibility', async () => {
    // Former preferred_then_fallback counterexample: phillips finds, bradley
    // must still run. Former preferred_only counterexample: every enabled
    // connection runs even though nothing is preferred.
    const phillips = new MockConnector('dist_phillips', 'found');
    const bradley = new MockConnector('dist_bradley', 'not_stocked');
    registry.register('dist_phillips', phillips);
    registry.register('dist_bradley', bradley);

    const items = insertItems(
      batchId,
      [{ upc: '064992524258', name: 'Acana Dog Food 25lb', brandHint: 'ACANA', rowNumber: 1 }],
      'sourcing',
      1,
    );
    const result = await runFor(items[0].id, '064992524258', 'ACANA');

    expect(result.attempts).toHaveLength(3);
    expect(result.attempts.filter((a) => a.outcome === 'found')).toHaveLength(2);
    expect(result.attempts.filter((a) => a.outcome === 'not_stocked')).toHaveLength(1);
    const reasons = result.skipped.map((s) => s.reason);
    expect(reasons).not.toContain('policy_preferred_only');
    expect(reasons).not.toContain('policy_preferred_match_found');
  });
});
