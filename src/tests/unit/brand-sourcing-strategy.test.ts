import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/connection';
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
  getBrandStrategyRow,
  saveBrandStrategy,
  computeBrandStrategyConfigurationToken,
} from '../../db/repositories/brand-strategy-approval-repo';
import { upsertBrandSite, findBrandSites } from '../../db/repositories/brand-site-repo';
import { upsertBrandAdvisoryProfile } from '../../db/repositories/distributor-repo';
import {
  captureGenerationStrategyBinding,
  getGenerationStrategyBinding,
} from '../../db/repositories/brand-strategy-generation-repo';
import { supersedeCurrentSourcingGeneration } from '../../db/repositories/onboarding-evidence-repo';
import { deriveBrandStrategies } from '../../onboarding/brand-hub/brand-strategy-derive';
import { DefaultSourcingEngine } from '../../onboarding/sourcing/engine';
import type { ConnectorRegistry } from '../../onboarding/sourcing/connector-registry';
import type { DistributorConnector, SourcingLookupRequest, SourcingLookupResult } from '../../onboarding/sourcing/contracts';
import {
  buildStrategyCollectionResult,
  parseStrategyCollectionResult,
  usableContributions,
} from '../../onboarding/sourcing/strategy-collection-result';
import { ApproveBrandStrategySchema } from '../../shared/schemas/brand-strategy';
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

describe('brand sourcing strategy approval (ticket #121; builder Amendment B1: Save is approval)', () => {
  it('distributor-only strategy with no domain persists, reloads, and pins a revision', () => {
    const approved = approveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [{ kind: 'distributor_record', distributorId: 'phillips' }, { kind: 'distributor_record', distributorId: 'bci' }],
      expectedRevision: 0,
      approvedBy: 'operator-1',
    });
    expect(approved.revision).toBe(1);
    expect(approved.approved).toBe(true);
    const reloaded = getApprovedBrandStrategy(workspaceId, 'acana');
    expect(reloaded?.sources).toHaveLength(2);
    expect(reloaded?.revision).toBe(1);
  });

  it('missing expectedRevision never writes', () => {
    expect(() => approveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [{ kind: 'distributor_record', distributorId: 'phillips' }],
    } as never)).toThrow(/expectedRevision/);
    expect(getApprovedBrandStrategy(workspaceId, 'Acana')).toBeNull();
  });

  it('stale expectedRevision is rejected without mutating the approved row', () => {
    approveBrandStrategy(workspaceId, { brand: 'Acana', sources: [{ kind: 'distributor_record', distributorId: 'phillips' }], expectedRevision: 0 });
    expect(() => approveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [{ kind: 'distributor_record', distributorId: 'bci' }],
      expectedRevision: 99,
    })).toThrow(/stale_revision/);
    expect(getApprovedBrandStrategy(workspaceId, 'Acana')?.sources).toEqual([
      { kind: 'distributor_record', distributorId: 'phillips' },
    ]);
  });

  it('every explicit Save creates a new revision, even identical sources', () => {
    approveBrandStrategy(workspaceId, { brand: 'Acana', sources: [{ kind: 'distributor_record', distributorId: 'phillips' }], expectedRevision: 0 });
    const again = approveBrandStrategy(workspaceId, { brand: 'Acana', sources: [{ kind: 'distributor_record', distributorId: 'phillips' }], expectedRevision: 1 });
    expect(again.revision).toBe(2);
  });

  it('guarded replay with the same previous revision is rejected without a new row', () => {
    approveBrandStrategy(workspaceId, { brand: 'Acana', sources: [{ kind: 'distributor_record', distributorId: 'phillips' }], expectedRevision: 0 });
    expect(() => approveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [{ kind: 'distributor_record', distributorId: 'phillips' }],
      expectedRevision: 0,
    })).toThrow(/stale_revision/);
    expect(getApprovedBrandStrategy(workspaceId, 'Acana')?.revision).toBe(1);
  });

  it('unknown source refs are rejected by shared validation', () => {
    expect(() => approveBrandStrategy(workspaceId, { brand: 'Acana', sources: [], expectedRevision: 0 })).toThrow();
    expect(() => approveBrandStrategy(workspaceId, {
      brand: 'Acana', sources: [{ kind: 'distributor_record' } as never], expectedRevision: 0,
    })).toThrow();
    expect(() => approveBrandStrategy(workspaceId, {
      brand: 'Acana', sources: [{ kind: 'distributor_record', distributorId: 'invented_distributor_xyz' }], expectedRevision: 0,
    })).toThrow(/unknown distributor/);
    expect(() => approveBrandStrategy(workspaceId, {
      brand: 'Acana', sources: [{ kind: 'official_page', domain: 'unmapped.example.com' }], expectedRevision: 0,
    })).toThrow(/not mapped/);
    expect(() => approveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [{ kind: 'official_page', domain: 'acme.com', distributorId: 'phillips' } as never],
      expectedRevision: 0,
    })).toThrow(/must not carry/);
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

    createDistributor({ id: 'dist_phillips', name: 'Phillips' });
    approveBrandStrategy(workspaceId, { brand: 'Acana', sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }], expectedRevision: 0 });
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
    createDistributor({ id: 'dist_phillips', name: 'Phillips' });
    createDistributor({ id: 'dist_bci', name: 'BCI' });
    approveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }],
      expectedRevision: 0,
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
      expectedRevision: 0,
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
      expectedRevision: 0,
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
    upsertBrandSite('Acana', 'acme.com');
    approveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [
        { kind: 'official_page', domain: 'acme.com' },
        { kind: 'distributor_record', distributorId: 'dist_phillips' },
      ],
      expectedRevision: 0,
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
    // Known distributor (row exists) but no enabled connection: valid Save,
    // zero usable sources at execution.
    createDistributor({ id: 'dist_phillips', name: 'Phillips' });
    approveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }],
      expectedRevision: 0,
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

describe('builder guarded atomic Save (slice B1)', () => {
  it('whitespace-only brand fails closed with nothing persisted (review-loop R1 P0-1)', () => {
    createDistributor({ id: 'dist_phillips', name: 'Phillips' });
    const parsed = ApproveBrandStrategySchema.safeParse({
      brand: '   ',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }],
      expectedRevision: 0,
    });
    expect(parsed.success).toBe(false);
    expect(() => saveBrandStrategy(workspaceId, {
      brand: '   ',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }],
      expectedRevision: 0,
    })).toThrow(/Invalid brand strategy approval/);
    const strays = getDb().query(
      `SELECT COUNT(*) AS n FROM brand_sourcing_strategies WHERE normalized_brand = ''`,
    ).get() as { n: number };
    expect(strays.n).toBe(0);
  });

  it('config-only Save applies mapping delta + preferences atomically and bumps exactly once', () => {
    createDistributor({ id: 'dist_phillips', name: 'Phillips' });
    const first = saveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }],
      expectedRevision: 0,
      approvedBy: 'op',
    });
    expect(first.revision).toBe(1);
    const token = computeBrandStrategyConfigurationToken(workspaceId, 'Acana');
    const second = saveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }],
      expectedRevision: 1,
      configuration: {
        officialDomains: ['acme.com'],
        aliases: ['acana pet'],
        preferredDistributorIds: ['dist_phillips'],
        sourcingPolicy: 'preferred_then_fallback',
      },
      expectedConfigurationToken: token,
      approvedBy: 'op',
    });
    expect(second.revision).toBe(2);
    expect(findBrandSites('acana').map((s) => s.domain)).toEqual(['acme.com']);
  });

  it('external mapping edit between read and Save is stale_configuration; counter-only updates do not invalidate', () => {
    createDistributor({ id: 'dist_phillips', name: 'Phillips' });
    upsertBrandSite('Acana', 'acme.com');
    saveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }],
      expectedRevision: 0,
    });
    const staleToken = computeBrandStrategyConfigurationToken(workspaceId, 'Acana');
    // External Domain Configuration edit (mapping add outside the builder).
    upsertBrandSite('Acana', 'other.example.org');
    expect(() => saveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }],
      expectedRevision: 1,
      configuration: {
        officialDomains: ['acme.com'],
        aliases: [],
        preferredDistributorIds: ['dist_phillips'],
        sourcingPolicy: 'advisory',
      },
      expectedConfigurationToken: staleToken,
    })).toThrow(/stale_configuration/);
    expect(getBrandStrategyRow(workspaceId, 'Acana')?.revision).toBe(1);

    // Pure usage-counter updates do not invalidate the token.
    const freshToken = computeBrandStrategyConfigurationToken(workspaceId, 'Acana');
    upsertBrandSite('Acana', 'acme.com');
    upsertBrandSite('Acana', 'other.example.org');
    expect(computeBrandStrategyConfigurationToken(workspaceId, 'Acana')).toBe(freshToken);
    const saved = saveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }],
      expectedRevision: 1,
      configuration: {
        officialDomains: ['acme.com', 'other.example.org'],
        aliases: [],
        preferredDistributorIds: ['dist_phillips'],
        sourcingPolicy: 'advisory',
      },
      expectedConfigurationToken: freshToken,
    });
    expect(saved.revision).toBe(2);
  });

  it('advisory collision rolls back mappings and approval together', () => {
    createDistributor({ id: 'dist_phillips', name: 'Phillips' });
    // Historical colliding spelling stored outside the builder.
    upsertBrandAdvisoryProfile({ workspaceId, brand: 'ACANA', aliases: [], preferredDistributorIds: [] });
    const token = computeBrandStrategyConfigurationToken(workspaceId, 'Acana');
    expect(() => saveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }],
      expectedRevision: 0,
      configuration: {
        officialDomains: ['acme.com'],
        aliases: [],
        preferredDistributorIds: ['dist_phillips'],
        sourcingPolicy: 'advisory',
      },
      expectedConfigurationToken: token,
    })).toThrow(/advisory_identity_conflict/);
    // Complete rollback: the staged mapping is gone (only the migration-seeded
    // acana.com remains) and no approval row was created.
    expect(findBrandSites('acana').map((s) => s.domain).sort()).toEqual(['acana.com']);
    expect(getBrandStrategyRow(workspaceId, 'Acana')).toBeNull();
  });

  it('removing a mapping deletes only this brand pair; other brands on the domain are untouched', () => {
    createDistributor({ id: 'dist_phillips', name: 'Phillips' });
    upsertBrandSite('Acana', 'shared.example.com');
    upsertBrandSite('Orijen', 'shared.example.com');
    saveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }],
      expectedRevision: 0,
      configuration: {
        officialDomains: [],
        aliases: [],
        preferredDistributorIds: ['dist_phillips'],
        sourcingPolicy: 'advisory',
      },
      expectedConfigurationToken: computeBrandStrategyConfigurationToken(workspaceId, 'Acana'),
    });
    // Only this brand's pair is removed (the migration-seeded acana.com is
    // replaced by the configuration delta); the other brand keeps both rows.
    expect(findBrandSites('acana').map((s) => s.domain).sort()).toEqual([]);
    expect(findBrandSites('orijen').map((s) => s.domain).sort()).toEqual(['orijenpetfoods.com', 'shared.example.com']);
  });

  it('concurrent first Saves: one winner, one stale_revision, no loser write', () => {
    createDistributor({ id: 'dist_phillips', name: 'Phillips' });
    createDistributor({ id: 'dist_bci', name: 'BCI' });
    const winner = saveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }],
      expectedRevision: 0,
    });
    expect(winner.revision).toBe(1);
    expect(() => saveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_bci' }],
      expectedRevision: 0,
    })).toThrow(/stale_revision/);
    expect(getApprovedBrandStrategy(workspaceId, 'Acana')?.sources).toEqual([
      { kind: 'distributor_record', distributorId: 'dist_phillips' },
    ]);
  });
});

describe('durable generation binding (slice B2)', () => {
  it('active generation keeps its revision across a later Save; retry captures the newest', async () => {
    seedConnections();
    saveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }],
      expectedRevision: 0,
    });
    const batch = createBatch({ workspaceId, name: 'b', fileName: 'b.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678905', name: 'Acana Food', brandHint: 'Acana', rowNumber: 1 }], 'sourcing', 1);
    const registry = new TestRegistry();
    registry.register('dist_phillips', new MockConnector('dist_phillips'));
    registry.register('dist_bci', new MockConnector('dist_bci'));
    const engine = new DefaultSourcingEngine(registry);

    const g1 = startSourcingGeneration(item.id);
    const r1 = await engine.runGeneration({
      itemId: item.id, generationId: g1.id, workspaceId, upc: '012345678905',
      brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });
    expect(r1.strategyRevision).toBe(1);
    expect(r1.attempts).toHaveLength(1);

    // Save revision 2 mid-flight: G1 stays pinned to revision 1.
    saveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [
        { kind: 'distributor_record', distributorId: 'dist_phillips' },
        { kind: 'distributor_record', distributorId: 'dist_bci' },
      ],
      expectedRevision: 1,
    });
    expect(getGenerationStrategyBinding(g1.id)).toMatchObject({ mode: 'approved', strategyRevision: 1 });
    // Re-entering G1 re-reads the same persisted binding.
    const r1b = await engine.runGeneration({
      itemId: item.id, generationId: g1.id, workspaceId, upc: '012345678905',
      brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });
    expect(r1b.strategyRevision).toBe(1);

    // Explicit retry supersedes G1 and captures revision 2.
    const g2 = supersedeCurrentSourcingGeneration(item.id, 'operator_retry');
    const r2 = await engine.runGeneration({
      itemId: item.id, generationId: g2.id, workspaceId, upc: '012345678905',
      brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });
    expect(r2.strategyRevision).toBe(2);
    expect(r2.attempts).toHaveLength(2);
  });

  it('evidence without a binding is uncertain; tampered and foreign bindings fail closed', async () => {
    seedConnections();
    saveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }],
      expectedRevision: 0,
    });
    const batch = createBatch({ workspaceId, name: 'b', fileName: 'b.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678905', name: 'Acana Food', brandHint: 'Acana', rowNumber: 1 }], 'sourcing', 1);
    const registry = new TestRegistry();
    registry.register('dist_phillips', new MockConnector('dist_phillips'));
    registry.register('dist_bci', new MockConnector('dist_bci'));
    const engine = new DefaultSourcingEngine(registry);
    const gen = startSourcingGeneration(item.id);
    await engine.runGeneration({
      itemId: item.id, generationId: gen.id, workspaceId, upc: '012345678905',
      brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });

    // Simulate pre-builder evidence: remove the snapshot, keep the attempts.
    const { getDb } = await import('../../db/connection');
    getDb().query('DELETE FROM sourcing_generation_strategy_snapshots WHERE sourcing_generation_id = ?').run(gen.id);
    expect(() => captureGenerationStrategyBinding({ workspaceId, itemId: item.id, generationId: gen.id }))
      .toThrow(/binding_uncertain/);

    // Tampered version fails closed on read.
    const gen2 = supersedeCurrentSourcingGeneration(item.id, 'operator_retry');
    captureGenerationStrategyBinding({ workspaceId, itemId: item.id, generationId: gen2.id });
    getDb().query("UPDATE sourcing_generation_strategy_snapshots SET binding_version = 'strategy-binding-v999' WHERE sourcing_generation_id = ?").run(gen2.id);
    expect(() => getGenerationStrategyBinding(gen2.id)).toThrow(/binding_invalid/);

    // Foreign workspace capture fails closed.
    expect(() => captureGenerationStrategyBinding({ workspaceId: 'ws-foreign', itemId: item.id, generationId: gen2.id }))
      .toThrow(/binding_invalid/);
  });
});
