import { describe, it, expect, beforeEach } from 'vitest';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { startSourcingGeneration } from '../../db/repositories/onboarding-evidence-repo';
import {
  createDistributor,
  createConnection,
  updateConnection,
} from '../../db/repositories/distributor-repo';
import {
  approveBrandStrategy,
  getApprovedBrandStrategy,
} from '../../db/repositories/brand-strategy-approval-repo';
import { deriveBrandStrategies } from '../../onboarding/brand-hub/brand-strategy-derive';
import { DefaultSourcingEngine } from '../../onboarding/sourcing/engine';
import type { ConnectorRegistry } from '../../onboarding/sourcing/connector-registry';
import type { DistributorConnector, SourcingLookupRequest, SourcingLookupResult } from '../../onboarding/sourcing/contracts';
import {
  buildStrategyCollectionResult,
  parseStrategyCollectionResult,
  usableContributions,
} from '../../onboarding/sourcing/strategy-collection-result';
import {
  assessListingEvidenceGap,
  openPreparationGap,
  getPreparationGap,
  hasUnresolvedPreparationGap,
  resolvePreparationGap,
} from '../../db/repositories/preparation-gap-repo';

class MockConnector implements DistributorConnector {
  readonly connectorType = 'api';
  readonly requiresSecret = false;
  readonly providerId: string;
  lookups = 0;
  constructor(readonly distributorId: string) {
    this.providerId = `provider_${distributorId}`;
  }
  async lookupByGtin(request: SourcingLookupRequest): Promise<SourcingLookupResult> {
    this.lookups += 1;
    return {
      outcome: 'found',
      record: {
        matchedIdentifier: request.upc,
        distributorUpc: request.upc,
        gtin: request.upc,
        distributorSku: `SKU_${this.distributorId}`,
        name: `Found Product ${this.distributorId}`,
        description: this.distributorId === 'dist_phillips' ? 'Specs here' : null,
        brand: 'Acana',
        manufacturerPartNumber: null,
        weight: '25lb',
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
}

class TestRegistry implements ConnectorRegistry {
  private connectors = new Map<string, DistributorConnector>();
  register(distributorId: string, connector: DistributorConnector) {
    this.connectors.set(distributorId, connector);
  }
  createConnector(_type: string, distributorId: string): DistributorConnector | null {
    return this.connectors.get(distributorId) ?? null;
  }
}

const workspaceId = 'ws-brand-strategy-test';

beforeEach(() => {
  initDb(':memory:');
  runMigrations();
  insertWorkspace({
    id: workspaceId,
    name: 'Strategy WS',
    workspacePath: '/tmp/test-strategy-ws',
    gitPath: '/tmp/test-strategy-ws/.git',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
});

function seedConnections() {
  for (const dist of ['dist_phillips', 'dist_bci']) {
    createDistributor({ id: dist, name: dist });
    const c = createConnection({ workspaceId, distributorId: dist, connectorType: 'api', configuration: {} });
    updateConnection(c.id, workspaceId, { enabled: true });
  }
}

describe('brand sourcing strategy approval (ticket #121)', () => {
  it('distributor-only strategy with no domain persists, reloads, and pins a revision', () => {
    const approved = approveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }, { kind: 'distributor_record', distributorId: 'dist_bci' }],
      approvedBy: 'operator-1',
    });
    expect(approved.revision).toBe(1);
    expect(approved.approved).toBe(true);
    const reloaded = getApprovedBrandStrategy(workspaceId, 'acana');
    expect(reloaded?.sources).toHaveLength(2);
    expect(reloaded?.revision).toBe(1);
  });

  it('stale expectedRevision is rejected without mutating the approved row', () => {
    approveBrandStrategy(workspaceId, { brand: 'Acana', sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }] });
    expect(() => approveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_bci' }],
      expectedRevision: 99,
    })).toThrow(/stale_revision/);
    expect(getApprovedBrandStrategy(workspaceId, 'Acana')?.sources).toEqual([
      { kind: 'distributor_record', distributorId: 'dist_phillips' },
    ]);
  });

  it('repeat identical approval is idempotent (no revision bump)', () => {
    approveBrandStrategy(workspaceId, { brand: 'Acana', sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }] });
    const again = approveBrandStrategy(workspaceId, { brand: 'Acana', sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }] });
    expect(again.revision).toBe(1);
  });

  it('unknown source refs are rejected by shared validation', () => {
    expect(() => approveBrandStrategy(workspaceId, { brand: 'Acana', sources: [] })).toThrow();
    expect(() => approveBrandStrategy(workspaceId, {
      brand: 'Acana', sources: [{ kind: 'distributor_record' } as never],
    })).toThrow();
  });

  it('derive marks unapproved brands awaiting approval and approved distributor-only brands ready', () => {
    const params = {
      brandSites: [],
      advisoryProfiles: [{ brand: 'Acana', aliases: [], preferredDistributorIds: ['dist_phillips'], sourcingPolicy: 'preferred_then_fallback' as const }],
      enabledDistributorIds: ['dist_phillips'],
    };
    const before = deriveBrandStrategies(params);
    expect(before[0].approval?.approved).toBe(false);
    expect(before[0].collectionReadiness).toBe('awaiting_approval');

    approveBrandStrategy(workspaceId, { brand: 'Acana', sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }] });
    const after = deriveBrandStrategies({
      ...params,
      approvals: new Map([['acana', { approved: true, revision: 1, approvedAt: new Date().toISOString(), approvedBy: 'op' }]]),
    });
    expect(after[0].approval?.approved).toBe(true);
    expect(after[0].collectionReadiness).toBe('ready');
    // Distributor sources never demand a profile.
    expect(after[0].sourceAvailability?.some((s) => s.reason === 'no_profile' && s.kind === 'distributor_record')).toBe(false);
  });

  it('approving a strict subset pins derive readiness/label to that subset', () => {
    approveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }],
    });
    const strategies = deriveBrandStrategies({
      brandSites: [],
      advisoryProfiles: [{ brand: 'Acana', aliases: [], preferredDistributorIds: ['dist_phillips', 'dist_bci'], sourcingPolicy: 'preferred_then_fallback' }],
      enabledDistributorIds: ['dist_phillips', 'dist_bci'],
      approvals: new Map([['acana', {
        approved: true, revision: 1, approvedAt: new Date().toISOString(), approvedBy: 'op',
        sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }],
      }]]),
    });
    expect(strategies[0].approvedSources).toEqual([{ kind: 'distributor_record', distributorId: 'dist_phillips' }]);
    // BCI is in the proposal but outside the approved boundary: invisible here.
    expect(strategies[0].sourceAvailability).toHaveLength(1);
    expect(strategies[0].sourceAvailability?.[0]).toMatchObject({ kind: 'distributor_record', ref: 'dist_phillips', available: true });
    expect(strategies[0].collectionReadiness).toBe('ready');
  });

  it('an approved official source is reported not_supported, never ready', () => {
    const strategies = deriveBrandStrategies({
      brandSites: [{ brandName: 'Fromm', domain: 'frommfamily.com' }],
      advisoryProfiles: [{ brand: 'Fromm', aliases: [], preferredDistributorIds: ['dist_phillips'], sourcingPolicy: 'advisory' }],
      readinessByDomain: new Map([['frommfamily.com', 'active' as const]]),
      enabledDistributorIds: ['dist_phillips'],
      approvals: new Map([['fromm', {
        approved: true, revision: 1, approvedAt: null, approvedBy: null,
        sources: [
          { kind: 'official_page', domain: 'frommfamily.com' },
          { kind: 'distributor_record', distributorId: 'dist_phillips' },
        ],
      }]]),
    });
    const official = strategies[0].sourceAvailability?.find((s) => s.kind === 'official_page');
    expect(official).toMatchObject({ available: false, reason: 'not_supported' });
    expect(strategies[0].collectionReadiness).toBe('ready_partial');
  });

  it('derive reports partial readiness when the official source lacks a profile', () => {
    const strategies = deriveBrandStrategies({
      brandSites: [{ brandName: 'Fromm', domain: 'frommfamily.com' }],
      advisoryProfiles: [{ brand: 'Fromm', aliases: [], preferredDistributorIds: ['dist_phillips', 'dist_bci'], sourcingPolicy: 'advisory' }],
      readinessByDomain: new Map([['frommfamily.com', 'not_configured' as const]]),
      enabledDistributorIds: ['dist_phillips', 'dist_bci'],
      approvals: new Map([['fromm', { approved: true, revision: 2, approvedAt: null, approvedBy: null }]]),
    });
    expect(strategies[0].collectionReadiness).toBe('ready_partial');
    expect(strategies[0].sourceAvailability?.find((s) => s.kind === 'official_page')?.reason).toBe('no_profile');
  });
});

describe('strategy-driven collection (tickets #122/#123)', () => {
  it('attempts every selected usable source — first success never short-circuits', async () => {
    seedConnections();
    approveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }, { kind: 'distributor_record', distributorId: 'dist_bci' }],
    });
    const batch = createBatch({ workspaceId, name: 'b', fileName: 'b.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678905', name: 'Acana Food', brandHint: 'Acana', rowNumber: 1 }], 'sourcing', 1);
    const registry = new TestRegistry();
    const phillips = new MockConnector('dist_phillips');
    const bci = new MockConnector('dist_bci');
    registry.register('dist_phillips', phillips);
    registry.register('dist_bci', bci);
    const generation = startSourcingGeneration(item.id);
    const engine = new DefaultSourcingEngine(registry);
    const result = await engine.runGeneration({
      itemId: item.id, generationId: generation.id, workspaceId, upc: '012345678905',
      brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });
    expect(phillips.lookups).toBe(1);
    expect(bci.lookups).toBe(1);
    expect(result.attempts).toHaveLength(2);
    expect(result.strategyRevision).toBe(1);
    expect(result.strategyBrand).toBe('acana');
  });

  it('approved subset runs only the subset — unapproved distributors are not attempted', async () => {
    seedConnections();
    approveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }],
    });
    const batch = createBatch({ workspaceId, name: 'b', fileName: 'b.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678905', name: 'Acana Food', brandHint: 'Acana', rowNumber: 1 }], 'sourcing', 1);
    const registry = new TestRegistry();
    const phillips = new MockConnector('dist_phillips');
    const bci = new MockConnector('dist_bci');
    registry.register('dist_phillips', phillips);
    registry.register('dist_bci', bci);
    const generation = startSourcingGeneration(item.id);
    const engine = new DefaultSourcingEngine(registry);
    const result = await engine.runGeneration({
      itemId: item.id, generationId: generation.id, workspaceId, upc: '012345678905',
      brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });
    expect(phillips.lookups).toBe(1);
    expect(bci.lookups).toBe(0);
    expect(result.attempts).toHaveLength(1);
  });

  it('approved official source is recorded as skipped (not_supported), distributors still run', async () => {
    seedConnections();
    approveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [
        { kind: 'official_page', domain: 'acme.com' },
        { kind: 'distributor_record', distributorId: 'dist_phillips' },
      ],
    });
    const batch = createBatch({ workspaceId, name: 'b', fileName: 'b.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678905', name: 'Acana Food', brandHint: 'Acana', rowNumber: 1 }], 'sourcing', 1);
    const registry = new TestRegistry();
    const phillips = new MockConnector('dist_phillips');
    const bci = new MockConnector('dist_bci');
    registry.register('dist_phillips', phillips);
    registry.register('dist_bci', bci);
    const generation = startSourcingGeneration(item.id);
    const engine = new DefaultSourcingEngine(registry);
    const result = await engine.runGeneration({
      itemId: item.id, generationId: generation.id, workspaceId, upc: '012345678905',
      brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });
    // No silent drop, no fake evidence: the official source is an explicit skip.
    expect(result.skipped.map((s) => s.reason)).toContain('strategy_official_not_yet_supported');
    expect(phillips.lookups).toBe(1);
    expect(bci.lookups).toBe(0);
    expect(result.attempts).toHaveLength(1);
  });

  it('approved strategy with no usable source yields setup attention, not a fake result', async () => {
    approveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }],
    });
    const batch = createBatch({ workspaceId, name: 'b', fileName: 'b.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678905', name: 'Acana Food', brandHint: 'Acana', rowNumber: 1 }], 'sourcing', 1);
    const generation2 = startSourcingGeneration(item.id);
    const engine = new DefaultSourcingEngine(new TestRegistry());
    const result2 = await engine.runGeneration({
      itemId: item.id, generationId: generation2.id, workspaceId, upc: '012345678905',
      brandHint: 'Acana', signal: AbortSignal.timeout(5000), deadlineAt: new Date().toISOString(),
    });
    expect(result2.attempts).toHaveLength(0);
    expect(result2.skipped[0].reason).toBe('strategy_no_usable_source');
  });

  it('versioned multi-contribution result keeps per-source typing; distributor URL fails closed', () => {
    const mixed = buildStrategyCollectionResult({
      itemId: 'item-1', sourcingGenerationId: 'gen-1', strategyRevision: 2, strategyBrand: 'fromm',
      contributions: [
        { kind: 'distributor_record', connectionId: 'conn-1', providerId: 'p1', attemptIds: ['a1'], sourceUrl: null, outcome: 'success', fields: { description: 'Specs' } },
        { kind: 'official_page', connectionId: null, providerId: 'page', attemptIds: [], sourceUrl: 'https://frommfamily.com/p', outcome: 'unavailable', reasonCode: 'no_profile', fields: {} },
      ],
    });
    expect(mixed?.version).toBe('strategy-collection-v1');
    expect(usableContributions(mixed!)).toHaveLength(1);
    expect(parseStrategyCollectionResult({ version: 'strategy-collection-v999' })).toBeNull();
    expect(buildStrategyCollectionResult({
      itemId: 'item-1', sourcingGenerationId: 'gen-1', strategyRevision: 1, strategyBrand: 'x',
      contributions: [{ kind: 'distributor_record', connectionId: 'c', providerId: 'p', attemptIds: ['a'], sourceUrl: 'https://fake.example', outcome: 'success', fields: {} }],
    })).toBeNull();
  });
});

describe('listing evidence gaps (ticket #124)', () => {
  it('optional omissions never open a gap; required gaps persist and resolve with operator attribution', () => {
    expect(assessListingEvidenceGap({ consolidatedFields: { title: 'T' }, requiredFields: [] }).missing).toEqual([]);
    const { missing } = assessListingEvidenceGap({
      consolidatedFields: { title: 'T', description: '  ' },
      requiredFields: ['title', 'description'],
    });
    expect(missing).toEqual(['description']);

    const batch = createBatch({ workspaceId, name: 'b', fileName: 'b.csv', totalItems: 1 });
    const gap = openPreparationGap({
      workspaceId, itemId: 'item-9', batchId: batch.id, missingFields: ['description'],
      reason: 'No description from collected sources.',
    });
    expect(hasUnresolvedPreparationGap('item-9')).toBe(true);
    // Idempotent reopen.
    expect(openPreparationGap({
      workspaceId, itemId: 'item-9', batchId: batch.id, missingFields: ['description'],
      reason: 'No description from collected sources.',
    }).id).toBe(gap.id);
    // Incomplete correction keeps the gap open.
    expect(() => resolvePreparationGap({ itemId: 'item-9', correction: {}, resolvedBy: 'op' })).toThrow(/missing values/);
    expect(hasUnresolvedPreparationGap('item-9')).toBe(true);
    const resolved = resolvePreparationGap({ itemId: 'item-9', correction: { description: 'Operator text' }, resolvedBy: 'op' });
    expect(resolved.status).toBe('resolved');
    expect(resolved.correction).toEqual({ description: 'Operator text' });
    expect(hasUnresolvedPreparationGap('item-9')).toBe(false);
    expect(getPreparationGap('item-9')?.status).toBe('resolved');
  });
});
