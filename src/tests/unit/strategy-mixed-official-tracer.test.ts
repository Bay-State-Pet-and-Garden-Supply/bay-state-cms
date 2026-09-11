/**
 * Ticket #123 tracer: mixed official-page + distributor-record collection
 * under one approved strategy boundary.
 *
 * DB-backed (real SQLite + migrations). Official legs run through injected
 * fake discover/verify/extract/profile deps — zero network, zero browser,
 * zero model calls. Distributor legs use the same MockConnectors as the
 * #122 tracer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  findItemById,
  completeSourcingWithDecision,
  updateItemStageStatus,
} from '../../db/repositories/onboarding-item-repo';
import { recordAcceptances } from '../../db/repositories/onboarding-acceptance-repo';
import {
  startSourcingGeneration,
  getCurrentSourcingGeneration,
  getEvidenceAttemptsByItemAndGeneration,
} from '../../db/repositories/onboarding-evidence-repo';
import {
  createDistributor,
  createConnection,
  updateConnection,
} from '../../db/repositories/distributor-repo';
import { saveBrandStrategy } from '../../db/repositories/brand-strategy-approval-repo';
import { upsertBrandSite } from '../../db/repositories/brand-site-repo';
import { DefaultSourcingEngine } from '../../onboarding/sourcing/engine';
import type { ConnectorRegistry } from '../../onboarding/sourcing/connector-registry';
import type { DistributorConnector, SourcingLookupRequest, SourcingLookupResult } from '../../onboarding/sourcing/contracts';
import { collectOfficialDomain } from '../../onboarding/sourcing/official-collector';
import { buildStrategyCollectionEnvelope } from '../../onboarding/sourcing/strategy-collection-result';
import {
  finalizeStrategyCollectionForGeneration,
  getStrategyCollectionResult,
} from '../../db/repositories/strategy-collection-result-repo';
import { reconcileDistributorEvidence } from '../../onboarding/sourcing-reconciler';
import { materializeStrategyCollectionExtraction } from '../../onboarding/sourcing/distributor-record-materializer';
import { isStrategyCollectionAuthorized } from '../../onboarding/product-curator';

type FieldProfile = { name: string | null; description: string | null; brand?: string | null; weight?: string | null };

class MockConnector implements DistributorConnector {
  readonly connectorType = 'api';
  readonly requiresSecret = false;
  readonly providerId: string;
  lookups = 0;
  constructor(
    readonly distributorId: string,
    private readonly profile: FieldProfile | null,
    private readonly outcome: 'found' | 'not_stocked' | 'source_error' = 'found',
  ) {
    this.providerId = `provider_${distributorId}`;
  }
  async lookupByGtin(request: SourcingLookupRequest): Promise<SourcingLookupResult> {
    this.lookups += 1;
    if (this.outcome === 'not_stocked') return { outcome: 'not_stocked', reason: 'no match in catalog' };
    if (this.outcome === 'source_error') return { outcome: 'source_error', code: 'timeout', message: 'upstream timeout' };
    const p = this.profile!;
    return {
      outcome: 'found',
      record: {
        matchedIdentifier: request.upc,
        distributorUpc: request.upc,
        gtin: request.upc,
        distributorSku: `SKU_${this.distributorId}`,
        name: p.name,
        description: p.description,
        brand: p.brand ?? 'Acana',
        manufacturerPartNumber: null,
        weight: p.weight ?? null,
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

const workspaceId = 'ws-123-mixed';
const OFFICIAL_URL = 'https://acme.com/products/acana-adult';

function makeOfficialDeps(overrides: Record<string, unknown> = {}) {
  return {
    findProfile: (() => ({ id: 'prof-acme', domain: 'acme.com' })) as never,
    isProfileHealthy: () => true,
    discover: (async () => ({
      candidates: [{ url: OFFICIAL_URL, title: 'Acana Adult', snippet: null, domain: 'acme.com', confidence: 0.95 }],
      consolidatedName: null,
    })) as never,
    verify: (async (candidates: Array<{ url: string }>) => candidates.map((c) => ({
      candidate: c,
      verificationScore: 100,
      signals: {},
      proofClass: 'gtin',
      hasStrongProof: true,
      extractedGtins: ['012345678905'],
      decisionReason: 'verified',
    }))) as never,
    extract: (async () => ({
      ok: true,
      data: { title: 'Acana Adult Dog', description: 'Official description', brand: 'Acana', weight: null },
      warnings: [],
      fieldProvenance: {},
    })) as never,
    ...overrides,
  };
}

beforeEach(() => {
  initDb(':memory:');
  runMigrations();
  insertWorkspace({
    id: workspaceId,
    name: 'Mixed WS',
    workspacePath: '/tmp/test-123-ws',
    gitPath: '/tmp/test-123-ws/.git',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bootstrapStatus: 'complete',
    baselineCommit: null,
  });
});

function seedConnections(ids: string[] = ['dist_phillips', 'dist_bci']) {
  for (const dist of ids) {
    createDistributor({ id: dist, name: dist });
    const c = createConnection({ workspaceId, distributorId: dist, connectorType: 'api', configuration: {} });
    updateConnection(c.id, workspaceId, { enabled: true });
  }
}

function approveMixed() {
  upsertBrandSite('Acana', 'acme.com');
  return saveBrandStrategy(workspaceId, {
    brand: 'Acana',
    sources: [
      { kind: 'official_page', domain: 'acme.com' },
      { kind: 'distributor_record', distributorId: 'dist_phillips' },
      { kind: 'distributor_record', distributorId: 'dist_bci' },
    ],
    expectedRevision: 0,
    approvedBy: 'op',
  });
}

function seedItem(upc = '012345678905') {
  const batch = createBatch({ workspaceId, name: 'b', fileName: 'b.csv', totalItems: 1 });
  const [item] = insertItems(
    batch.id,
    [{ upc, name: 'Acana Food', brandHint: 'Acana', rowNumber: 1 }],
    'route_sources',
    1,
  );
  return { batch, item };
}

function strategyDecision(generationId: string, accepted: string[], providers: string[], hash: string) {
  return {
    schemaVersion: 2 as const,
    route: 'completed_strategy_collection' as const,
    origin: 'automatic_policy' as const,
    acceptedEvidenceAttemptIds: [...accepted].sort(),
    providerIds: [...providers].sort(),
    sourcingGenerationId: generationId,
    evidenceHash: hash,
    sourceType: 'distributor_record' as const,
    target: 'extraction' as const,
    conflicts: [],
    warnings: [],
    decidedAt: new Date().toISOString(),
  };
}

describe('ticket #123: mixed official-page + distributor collection', () => {
  it('happy path: official description + distributor spec consolidate with attribution; no first-success cancel', async () => {
    seedConnections();
    approveMixed();
    const { item } = seedItem();
    const registry = new TestRegistry();
    // Phillips supplies the spec (weight) only; BCI matches nothing useful.
    registry.register('dist_phillips', new MockConnector('dist_phillips', { name: null, description: null, weight: '25lb' }));
    registry.register('dist_bci', new MockConnector('dist_bci', null, 'not_stocked'));
    const generation = startSourcingGeneration(item.id);
    const engine = new DefaultSourcingEngine(registry, 3, makeOfficialDeps());
    const result = await engine.runGeneration({
      itemId: item.id, generationId: generation.id, workspaceId, upc: '012345678905',
      brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });
    // Every planned source ran: 2 distributor attempts + 1 official attempt.
    expect(result.attempts).toHaveLength(3);
    const official = result.attempts.find((a) => a.providerId === 'official_page:acme.com');
    expect(official).toMatchObject({ outcome: 'found', errorCode: null });

    const finalized = finalizeStrategyCollectionForGeneration({ workspaceId, itemId: item.id, generationId: generation.id });
    const officialContribution = finalized.envelope.contributions.find((c) => c.kind === 'official_page');
    expect(officialContribution).toMatchObject({ outcome: 'success', sourceUrl: OFFICIAL_URL });
    expect(officialContribution?.fields.description).toBe('Official description');
    // Distributor URL-null guarantee holds inside mixed envelopes.
    for (const c of finalized.envelope.contributions) {
      if (c.kind === 'distributor_record') expect(c.sourceUrl).toBeNull();
    }

    // Preparation consolidates across kinds with per-field attribution.
    const attemptIds = result.attempts.filter((a) => a.outcome === 'found').map((a) => a.attemptId).sort();
    const providers = result.attempts.filter((a) => a.outcome === 'found').map((a) => a.providerId).sort();
    recordAcceptances(item.id, attemptIds, 'system', 'test mixed');
    expect(completeSourcingWithDecision(item.id, strategyDecision(generation.id, attemptIds, providers, finalized.hash), 'collect_details').ok).toBe(true);
    updateItemStageStatus(item.id, 'in_progress');
    const materialized = materializeStrategyCollectionExtraction(item.id, workspaceId);
    expect(materialized.ok).toBe(true);
    if (materialized.ok) {
      expect(materialized.extractionData.description).toBe('Official description');
      expect(materialized.extractionData.fieldProvenance).toMatchObject({ description: 'official_page:acme.com' });
      expect(materialized.extractionData.sourceUrl).toBeNull();
      // The curator authority linkage holds for mixed envelopes.
      expect(isStrategyCollectionAuthorized(
        materialized.extractionData as Record<string, unknown>,
        (findItemById(item.id)?.sourcingDecision as { evidenceHash?: string })?.evidenceHash ?? null,
      )).toBe(true);
    }
  });

  it('unavailable profile: distributors run, website stays visibly unavailable, preparation proceeds', async () => {
    seedConnections();
    approveMixed();
    const { item } = seedItem();
    const registry = new TestRegistry();
    registry.register('dist_phillips', new MockConnector('dist_phillips', { name: 'Acana Adult Dog', description: 'Specs' }));
    registry.register('dist_bci', new MockConnector('dist_bci', null, 'not_stocked'));
    const generation = startSourcingGeneration(item.id);
    // Profile gate fires before ANY network: counters prove zero
    // discover/extract calls on the profile_required path.
    const guard = { discoverCalls: 0, extractCalls: 0 };
    const engine = new DefaultSourcingEngine(registry, 3, makeOfficialDeps({
      findProfile: (() => null) as never,
      discover: (async () => {
        guard.discoverCalls += 1;
        return { candidates: [], consolidatedName: null };
      }) as never,
      extract: (async () => {
        guard.extractCalls += 1;
        throw new Error('must not extract without a profile');
      }) as never,
    }));
    const result = await engine.runGeneration({
      itemId: item.id, generationId: generation.id, workspaceId, upc: '012345678905',
      brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });
    expect(result.attempts).toHaveLength(3);
    const finalized = finalizeStrategyCollectionForGeneration({ workspaceId, itemId: item.id, generationId: generation.id });
    const official = finalized.envelope.contributions.find((c) => c.kind === 'official_page');
    // Visibly unavailable (never bypassed, never blocking): preparation uses
    // the distributor evidence.
    expect(official).toMatchObject({ outcome: 'unavailable', reasonCode: 'profile_required' });
    expect(finalized.envelope.contributions.filter((c) => c.outcome === 'success')).toHaveLength(1);
    expect(guard.discoverCalls).toBe(0);
    expect(guard.extractCalls).toBe(0);
  });

  it('unhealthy profile performs zero network calls', async () => {
    seedConnections();
    approveMixed();
    const { item } = seedItem();
    const registry = new TestRegistry();
    registry.register('dist_phillips', new MockConnector('dist_phillips', { name: 'Acana Adult Dog', description: 'Specs' }));
    registry.register('dist_bci', new MockConnector('dist_bci', null, 'not_stocked'));
    const generation = startSourcingGeneration(item.id);
    const guard = { discoverCalls: 0, extractCalls: 0 };
    const engine = new DefaultSourcingEngine(registry, 3, makeOfficialDeps({
      isProfileHealthy: () => false,
      discover: (async () => {
        guard.discoverCalls += 1;
        return { candidates: [], consolidatedName: null };
      }) as never,
      extract: (async () => {
        guard.extractCalls += 1;
        throw new Error('must not extract with an unhealthy profile');
      }) as never,
    }));
    const result = await engine.runGeneration({
      itemId: item.id, generationId: generation.id, workspaceId, upc: '012345678905',
      brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });
    expect(result.attempts).toHaveLength(3);
    const finalized = finalizeStrategyCollectionForGeneration({ workspaceId, itemId: item.id, generationId: generation.id });
    expect(finalized.envelope.contributions.find((c) => c.kind === 'official_page'))
      .toMatchObject({ outcome: 'unavailable', reasonCode: 'profile_not_healthy' });
    expect(guard.discoverCalls).toBe(0);
    expect(guard.extractCalls).toBe(0);
  });

  it('official terminal failures stay truthful per source while siblings continue', async () => {
    seedConnections();
    approveMixed();
    const cases: Array<{ name: string; deps: Record<string, unknown>; outcome: string; reason: string }> = [
      { name: 'no candidates', deps: { discover: (async () => ({ candidates: [], consolidatedName: null })) as never }, outcome: 'no_match', reason: 'not_stocked' },
      {
        name: 'blocked fetch wall',
        deps: {
          verify: ((async (candidates: Array<{ url: string }>, _ctx: unknown, _n: number, fetchImpl: typeof fetch) => {
            // Mirror the real verifier's transport use so the collector's
            // bounded diagnostics observe the wall instead of a quiet empty.
            for (const c of candidates) {
              try { await fetchImpl(c.url); } catch { /* counted by the collector */ }
            }
            return [];
          }) as never),
          fetchFn: ((async () => { throw new Error('blocked'); }) as unknown) as typeof fetch,
        },
        outcome: 'failed', reason: 'fetch_failed',
      },
      { name: 'unhealthy profile', deps: { isProfileHealthy: () => false }, outcome: 'unavailable', reason: 'profile_not_healthy' },
      { name: 'extraction failure', deps: { extract: (async () => ({ ok: false, error: 'worker down', warnings: [] })) as never }, outcome: 'failed', reason: 'extract_failed' },
    ];
    for (const [index, failure] of cases.entries()) {
      const { item } = seedItem(`0123456789${String(10 + index)}`);
      const registry = new TestRegistry();
      registry.register('dist_phillips', new MockConnector('dist_phillips', { name: 'Acana Adult Dog', description: 'Specs' }));
      registry.register('dist_bci', new MockConnector('dist_bci', { name: 'Acana Adult Dog', description: 'Specs' }));
      const generation = startSourcingGeneration(item.id);
      const engine = new DefaultSourcingEngine(registry, 3, makeOfficialDeps(failure.deps));
      const result = await engine.runGeneration({
        itemId: item.id, generationId: generation.id, workspaceId, upc: `0123456789${String(10 + index)}`,
        brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
      });
      // Siblings continue: both distributors attempted regardless.
      expect(result.attempts.filter((a) => a.providerId.startsWith('provider_'))).toHaveLength(2);
      const finalized = finalizeStrategyCollectionForGeneration({ workspaceId, itemId: item.id, generationId: generation.id });
      const official = finalized.envelope.contributions.find((c) => c.kind === 'official_page');
      expect(official, failure.name).toMatchObject({ outcome: failure.outcome, reasonCode: failure.reason });
    }
  });

  it('interrupted official leg fails finalization; resume completes without duplicating distributor work', async () => {
    seedConnections();
    approveMixed();
    const { item } = seedItem();
    const registry = new TestRegistry();
    const phillips = new MockConnector('dist_phillips', { name: 'Acana Adult Dog', description: 'Specs' });
    const bci = new MockConnector('dist_bci', { name: 'Acana Adult Dog', description: 'Specs' });
    registry.register('dist_phillips', phillips);
    registry.register('dist_bci', bci);
    // First run: the deadline is already spent, so the official leg skips
    // without a terminal attempt (distributors persist normally).
    const generation = startSourcingGeneration(item.id);
    const stalled = new DefaultSourcingEngine(registry, 3, makeOfficialDeps());
    const partial = await stalled.runGeneration({
      itemId: item.id, generationId: generation.id, workspaceId, upc: '012345678905',
      brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(partial.attempts).toHaveLength(2);
    expect(() => finalizeStrategyCollectionForGeneration({ workspaceId, itemId: item.id, generationId: generation.id }))
      .toThrow(/incomplete_collection/);
    // Resume with budget: the official leg completes; finished distributor
    // legs are re-read, never re-fetched.
    const resumed = new DefaultSourcingEngine(registry, 3, makeOfficialDeps());
    const completed = await resumed.runGeneration({
      itemId: item.id, generationId: generation.id, workspaceId, upc: '012345678905',
      brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });
    expect(phillips.lookups).toBe(1);
    expect(bci.lookups).toBe(1);
    expect(completed.attempts).toHaveLength(3);
    const finalized = finalizeStrategyCollectionForGeneration({ workspaceId, itemId: item.id, generationId: generation.id });
    expect(finalized.envelope.contributions.find((c) => c.kind === 'official_page')).toMatchObject({ outcome: 'success' });
  });

  it('live approval edits cannot expand a running generation; retailer domains never collect', async () => {
    seedConnections();
    approveMixed();
    const { item } = seedItem();
    const registry = new TestRegistry();
    registry.register('dist_phillips', new MockConnector('dist_phillips', { name: 'Acana Adult Dog', description: 'Specs' }));
    registry.register('dist_bci', new MockConnector('dist_bci', { name: 'Acana Adult Dog', description: 'Specs' }));
    const generation = startSourcingGeneration(item.id);
    // Pin the rev-1 boundary BEFORE the live edit below.
    const { captureGenerationStrategyBinding } = await import('../../db/repositories/brand-strategy-generation-repo');
    captureGenerationStrategyBinding({ workspaceId, itemId: item.id, generationId: generation.id });
    // Widen the LIVE approval after the generation started (new distributor
    // + new official domain). The frozen pin must not move.
    // + new official domain). The frozen pin must not move.
    upsertBrandSite('Acana', 'new-official.example.com');
    createDistributor({ id: 'dist_new', name: 'New' });
    saveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [
        { kind: 'official_page', domain: 'acme.com' },
        { kind: 'official_page', domain: 'new-official.example.com' },
        { kind: 'distributor_record', distributorId: 'dist_phillips' },
        { kind: 'distributor_record', distributorId: 'dist_bci' },
        { kind: 'distributor_record', distributorId: 'dist_new' },
      ],
      expectedRevision: 1,
    });
    let discoverCalls = 0;
    const engine = new DefaultSourcingEngine(registry, 3, makeOfficialDeps({
      discover: (async () => {
        discoverCalls += 1;
        return { candidates: [], consolidatedName: null };
      }) as never,
    }));
    await engine.runGeneration({
      itemId: item.id, generationId: generation.id, workspaceId, upc: '012345678905',
      brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });
    // Only the frozen rev-1 official domain collected; the rev-2 domain and
    // distributor were never attempted or discovered.
    expect(discoverCalls).toBe(1);
    const providers = getEvidenceAttemptsByItemAndGeneration(item.id, generation.id).map((a) => a.providerId);
    expect(providers).not.toContain('official_page:new-official.example.com');

    // Retailer defense in depth: even a direct call never fetches.
    let retailerDiscoverCalls = 0;
    const retailer = await collectOfficialDomain({
      itemId: item.id, generationId: generation.id, workspaceId,
      domain: 'chewy.com', identifier: '012345678905', itemName: 'Acana Food', brandHint: 'Acana',
      signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
      deps: makeOfficialDeps({
        discover: (async () => {
          retailerDiscoverCalls += 1;
          return { candidates: [], consolidatedName: null };
        }) as never,
      }),
    });
    expect(retailer.kind).toBe('attempt');
    if (retailer.kind === 'attempt') expect(retailer.summary.errorCode).toBe('retailer_domain');
    expect(retailerDiscoverCalls).toBe(0);
  });

  it('cross-source identity conflict stays upstream and prevents blending', async () => {
    seedConnections();
    approveMixed();
    const { item } = seedItem();
    const registry = new TestRegistry();
    registry.register('dist_phillips', new MockConnector('dist_phillips', { name: 'Acana Adult Dog', description: 'Specs', weight: '25lb' }));
    registry.register('dist_bci', new MockConnector('dist_bci', null, 'not_stocked'));
    const generation = startSourcingGeneration(item.id);
    const engine = new DefaultSourcingEngine(registry, 3, makeOfficialDeps({
      extract: (async () => ({
        ok: true,
        data: { title: 'Acana Adult Dog', description: 'Official description', brand: 'Acana', weight: '10lb' },
        warnings: [],
        fieldProvenance: {},
      })) as never,
    }));
    await engine.runGeneration({
      itemId: item.id, generationId: generation.id, workspaceId, upc: '012345678905',
      brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });
    const attempts = getEvidenceAttemptsByItemAndGeneration(item.id, generation.id);
    const { reconcileDistributorEvidence: reconcile } = await import('../../onboarding/sourcing-reconciler');
    const evaluation = reconcile(item.id, attempts, generation.id, []);
    // Weight disagreement across official/distributor is identity-critical:
    // nothing is accepted for blending.
    expect(evaluation.hasHardIdentityConflict).toBe(true);
    expect(evaluation.acceptedAttemptIds).toEqual([]);
  });

  it('envelope builder rejects unidentified sources and URL-less official success', () => {
    expect(buildStrategyCollectionEnvelope({
      itemId: 'item-1', generationId: 'gen-1', strategyRevision: 1, strategyBrand: 'acana',
      sources: [{ kind: 'official_page', domain: '' }],
      attempts: [],
      unavailableDistributorIds: [],
    })).toBeNull();
    expect(buildStrategyCollectionEnvelope({
      itemId: 'item-1', generationId: 'gen-1', strategyRevision: 1, strategyBrand: 'acana',
      sources: [{ kind: 'official_page', domain: 'acme.com' }],
      attempts: [{
        attemptId: 'a1', connectionId: '', distributorId: 'acme.com', providerId: 'official_page:acme.com',
        outcome: 'found', identityJson: JSON.stringify({ name: 'Acana' }),
      }],
      unavailableDistributorIds: [],
    })).toBeNull();
  });

  it('curator authority helper authorizes hash-bound envelopes and nothing else', () => {
    const hash = 'a'.repeat(64);
    expect(isStrategyCollectionAuthorized({ strategyCollectionProvenance: { strategyCollectionHash: hash } }, hash)).toBe(true);
    expect(isStrategyCollectionAuthorized({ strategyCollectionProvenance: { strategyCollectionHash: hash } }, 'b'.repeat(64))).toBe(false);
    expect(isStrategyCollectionAuthorized({}, hash)).toBe(false);
    expect(isStrategyCollectionAuthorized({ strategyCollectionProvenance: {} }, hash)).toBe(false);
  });

  it('read surface exposes mixed contributions with URLs and reasons', async () => {
    seedConnections();
    approveMixed();
    const { item } = seedItem();
    const registry = new TestRegistry();
    registry.register('dist_phillips', new MockConnector('dist_phillips', { name: 'Acana Adult Dog', description: 'Specs' }));
    registry.register('dist_bci', new MockConnector('dist_bci', null, 'not_stocked'));
    const generation = startSourcingGeneration(item.id);
    const engine = new DefaultSourcingEngine(registry, 3, makeOfficialDeps());
    await engine.runGeneration({
      itemId: item.id, generationId: generation.id, workspaceId, upc: '012345678905',
      brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });
    const finalizedRead = finalizeStrategyCollectionForGeneration({ workspaceId, itemId: item.id, generationId: generation.id });
    const { envelope } = getStrategyCollectionResult(finalizedRead.envelope.sourcingGenerationId);
    const official = envelope.contributions.find((c) => c.kind === 'official_page');
    expect(official).toMatchObject({ outcome: 'success', sourceUrl: OFFICIAL_URL });
    expect(envelope.contributions.map((c) => `${c.kind}:${c.outcome}`).sort()).toEqual(
      ['distributor_record:no_match', 'distributor_record:success', 'official_page:success'],
    );
    void getDb;
  });
});
