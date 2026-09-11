/**
 * Ticket #122 tracer: approved distributor-only strategy → bounded collection
 * → durable envelope → Collect details → preparation (prepared or gap).
 *
 * DB-backed (real SQLite + migrations, fake distributor connectors).
 * No page fetch / profile / OCR / model / image calls exist in the
 * acquisition path — asserted by construction (MockConnectors only) and by
 * URL-null + no-Discovery routing assertions.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, findItemById, completeSourcingWithDecision, updateItemStageStatus } from '../../db/repositories/onboarding-item-repo';
import { recordAcceptances } from '../../db/repositories/onboarding-acceptance-repo';
import {
  startSourcingGeneration,
  getCurrentSourcingGeneration,
} from '../../db/repositories/onboarding-evidence-repo';
import { supersedeCurrentSourcingGeneration } from '../../db/repositories/onboarding-evidence-repo';
import {
  createDistributor,
  createConnection,
  updateConnection,
} from '../../db/repositories/distributor-repo';
import { saveBrandStrategy } from '../../db/repositories/brand-strategy-approval-repo';
import { captureGenerationStrategyBinding } from '../../db/repositories/brand-strategy-generation-repo';
import { DefaultSourcingEngine } from '../../onboarding/sourcing/engine';
import type { ConnectorRegistry } from '../../onboarding/sourcing/connector-registry';
import type { DistributorConnector, SourcingLookupRequest, SourcingLookupResult } from '../../onboarding/sourcing/contracts';
import {
  buildStrategyCollectionEnvelope,
  buildStrategyCollectionResult,
} from '../../onboarding/sourcing/strategy-collection-result';
import {
  finalizeStrategyCollectionForGeneration,
  getStrategyCollectionResult,
} from '../../db/repositories/strategy-collection-result-repo';
import {
  assessListingEvidenceGap,
  openPreparationGap,
  getPreparationGap,
  recordGapCorrection,
  resolveAfterValidation,
} from '../../db/repositories/preparation-gap-repo';
import { approveAndAdvanceItems } from '../../db/repositories/onboarding-review-repo';
import { materializeStrategyCollectionExtraction } from '../../onboarding/sourcing/distributor-record-materializer';
import { OnboardingWorker } from '../../onboarding/job-queue';
import { overrideSourcingFlags, resetSourcingFlagsOverride } from '../../onboarding/flags';
import { SOURCING_ENTRY_POLICY_VERSION } from '../../onboarding/sourcing/entry-policy';
import { toCanonicalStored } from '../../db/repositories/onboarding-stage-vocabulary-repo';
import { Hono } from 'hono';
import { strategyCollectionRoutes } from '../../server/routes/strategy-collection-routes';

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
    private readonly onlyUpcs?: Set<string>,
  ) {
    this.providerId = `provider_${distributorId}`;
  }
  async lookupByGtin(request: SourcingLookupRequest): Promise<SourcingLookupResult> {
    this.lookups += 1;
    if (this.onlyUpcs && !this.onlyUpcs.has(request.upc)) {
      return { outcome: 'not_stocked', reason: 'no match in catalog' };
    }
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

const workspaceId = 'ws-122-tracer';

beforeEach(() => {
  initDb(':memory:');
  runMigrations();
  insertWorkspace({
    id: workspaceId,
    name: 'Tracer WS',
    workspacePath: '/tmp/test-122-ws',
    gitPath: '/tmp/test-122-ws/.git',
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

function approveAcana(sources: Array<{ kind: 'distributor_record'; distributorId: string }> = [
  { kind: 'distributor_record', distributorId: 'dist_phillips' },
  { kind: 'distributor_record', distributorId: 'dist_bci' },
]) {
  return saveBrandStrategy(workspaceId, { brand: 'Acana', sources, expectedRevision: 0, approvedBy: 'op' });
}

function seedItem(upc = '012345678905', brandHint: string | null = 'Acana') {
  const batch = createBatch({ workspaceId, name: 'b', fileName: 'b.csv', totalItems: 1 });
  const [item] = insertItems(
    batch.id,
    [{ upc, name: 'Acana Food', brandHint, rowNumber: 1 }],
    'route_sources',
    1,
  );
  return { batch, item };
}

describe('ticket #122: complementary distributor-only collection', () => {
  it('two sparse records complement each other; hash is order-deterministic; attribution preserved', async () => {
    seedConnections();
    approveAcana();
    const { item } = seedItem();
    const registry = new TestRegistry();
    // Phillips supplies the name only; BCI supplies the description only.
    registry.register('dist_phillips', new MockConnector('dist_phillips', { name: 'Acana Adult Dog', description: null }));
    registry.register('dist_bci', new MockConnector('dist_bci', { name: null, description: 'Complete nutrition' }));
    const generation = startSourcingGeneration(item.id);
    const engine = new DefaultSourcingEngine(registry);
    const result = await engine.runGeneration({
      itemId: item.id, generationId: generation.id, workspaceId, upc: '012345678905',
      brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });
    // No short-circuit: both selected sources attempted.
    expect(result.attempts).toHaveLength(2);

    const finalized = finalizeStrategyCollectionForGeneration({ workspaceId, itemId: item.id, generationId: generation.id });
    expect(finalized.envelope.contributions.filter((c) => c.outcome === 'success')).toHaveLength(2);
    // Distributor contributions are URL-null (never a fake official URL).
    for (const c of finalized.envelope.contributions) {
      if (c.kind === 'distributor_record') expect(c.sourceUrl).toBeNull();
    }
    // Attribution: name came from Phillips, description from BCI.
    const byProvider = new Map(finalized.envelope.contributions.map((c) => [c.providerId, c]));
    expect(byProvider.get('provider_dist_phillips')?.fields.name).toBe('Acana Adult Dog');
    expect(byProvider.get('provider_dist_bci')?.fields.description).toBe('Complete nutrition');

    // Order-reversal determinism: same attempts in reverse build the same hash.
    const reversed = buildStrategyCollectionEnvelope({
      itemId: item.id,
      generationId: generation.id,
      strategyRevision: 1,
      strategyBrand: 'acana',
      sources: [
        { kind: 'distributor_record', distributorId: 'dist_phillips' },
        { kind: 'distributor_record', distributorId: 'dist_bci' },
      ],
      attempts: [...finalized.attemptInputs].reverse(),
      unavailableDistributorIds: [],
      identityConflict: false,
    });
    expect(reversed?.hash).toBe(finalized.hash);
  });

  it('partial availability: disabled source persists a distinct readable outcome; usable source still collects', async () => {
    // BCI row exists (approvable) but has no enabled connection.
    seedConnections(['dist_phillips']);
    createDistributor({ id: 'dist_bci', name: 'BCI' });
    approveAcana();
    const { item } = seedItem();
    const registry = new TestRegistry();
    registry.register('dist_phillips', new MockConnector('dist_phillips', { name: 'Acana Adult Dog', description: 'Specs' }));
    const generation = startSourcingGeneration(item.id);
    const engine = new DefaultSourcingEngine(registry);
    const result = await engine.runGeneration({
      itemId: item.id, generationId: generation.id, workspaceId, upc: '012345678905',
      brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });
    expect(result.attempts).toHaveLength(1);
    expect(result.unavailableStrategySources).toEqual(['dist_bci']);

    const finalized = finalizeStrategyCollectionForGeneration({ workspaceId, itemId: item.id, generationId: generation.id });
    const unavailable = finalized.envelope.contributions.find((c) => c.outcome === 'unavailable');
    expect(unavailable).toMatchObject({ kind: 'distributor_record', reasonCode: 'connection_not_configured' });
    // Read surface: persisted envelope reloads with the distinct outcome.
    const reloaded = getStrategyCollectionResult(generation.id);
    expect(reloaded.envelope.contributions).toHaveLength(2);
    expect(reloaded.envelope.contributions.map((c: { outcome: string }) => c.outcome).sort()).toEqual(['success', 'unavailable']);
  });

  it('exhausted attempts finalize a completed (empty) envelope; never-started stays setup attention', async () => {
    seedConnections();
    approveAcana();
    // Exhausted: both connectors return not_stocked — attempts exist.
    const { item } = seedItem();
    const registry = new TestRegistry();
    registry.register('dist_phillips', new MockConnector('dist_phillips', null, 'not_stocked'));
    registry.register('dist_bci', new MockConnector('dist_bci', null, 'not_stocked'));
    const generation = startSourcingGeneration(item.id);
    const engine = new DefaultSourcingEngine(registry);
    const result = await engine.runGeneration({
      itemId: item.id, generationId: generation.id, workspaceId, upc: '012345678905',
      brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });
    expect(result.attempts).toHaveLength(2);
    const finalized = finalizeStrategyCollectionForGeneration({ workspaceId, itemId: item.id, generationId: generation.id });
    expect(finalized.envelope.contributions.filter((c) => c.outcome === 'success')).toHaveLength(0);
    expect(finalized.envelope.contributions).toHaveLength(2);

    // Never-started: a fresh generation the engine never ran has no frozen
    // binding, so finalization fails closed before even reaching the
    // attempts check (attempts alone never prove completion).
    const { item: item2 } = seedItem('012345678906');
    const gen2 = startSourcingGeneration(item2.id);
    expect(() => finalizeStrategyCollectionForGeneration({ workspaceId, itemId: item2.id, generationId: gen2.id }))
      .toThrow(/missing_binding/);
    // Binding captured but zero attempts started: stays setup attention.
    captureGenerationStrategyBinding({ workspaceId, itemId: item2.id, generationId: gen2.id });
    expect(() => finalizeStrategyCollectionForGeneration({ workspaceId, itemId: item2.id, generationId: gen2.id }))
      .toThrow(/no_attempts/);
  });

  it('sufficiency gaps block approval; optional omissions do not; gap writes are hash-bound and idempotent', () => {
    const { batch, item } = seedItem();
    // Required gap assessed post-consolidation: missing description opens one.
    const { missing } = assessListingEvidenceGap({
      consolidatedFields: { title: 'Acana Adult Dog', description: '  ' },
      requiredFields: ['title', 'description'],
    });
    expect(missing).toEqual(['description']);
    const gap = openPreparationGap({
      workspaceId, itemId: item.id, batchId: batch.id, missingFields: missing,
      reason: 'No description from collected sources.', evidenceHash: 'a'.repeat(64),
    });
    expect(gap.evidenceHash).toBe('a'.repeat(64));
    // Idempotent reopen with the same hash returns the same row.
    expect(openPreparationGap({
      workspaceId, itemId: item.id, batchId: batch.id, missingFields: missing,
      reason: 'No description from collected sources.', evidenceHash: 'a'.repeat(64),
    }).id).toBe(gap.id);
    // Same missing set but a NEW collection hash refreshes the stored hash (never stale).
    const refreshed = openPreparationGap({
      workspaceId, itemId: item.id, batchId: batch.id, missingFields: missing,
      reason: 'No description from collected sources.', evidenceHash: 'b'.repeat(64),
    });
    expect(refreshed.id).toBe(gap.id);
    expect(refreshed.evidenceHash).toBe('b'.repeat(64));
    expect(getPreparationGap(item.id)?.evidenceHash).toBe('b'.repeat(64));
    // Optional omission alone never opens a gap.
    expect(assessListingEvidenceGap({
      consolidatedFields: { title: 'T', description: 'D' },
      requiredFields: [],
    }).missing).toEqual([]);
  });

  it('open hash-bound gap blocks review approval until resolved', () => {
    const { batch, item } = seedItem();
    getDb().query("UPDATE onboarding_items SET stage = 'review_listings', stage_status = 'completed' WHERE id = ?").run(item.id);
    openPreparationGap({
      workspaceId, itemId: item.id, batchId: batch.id, missingFields: ['description'],
      reason: 'No description from collected sources.', evidenceHash: 'c'.repeat(64),
    });
    const blocked = approveAndAdvanceItems({
      itemIds: [item.id], batchId: batch.id, approvedBy: 'op', requestHash: 'd'.repeat(64),
    });
    expect(blocked.rejected.some((r) => r.itemId === item.id && r.reason === 'preparation_gap_unresolved')).toBe(true);
    // Ticket #124: gaps clear only through the validated record + resolve
    // flow (the direct-resolve bypass is removed).
    const { envelope } = recordGapCorrection({
      itemId: item.id, values: { description: 'Operator text' }, actor: 'op', role: 'catalog_approver',
    });
    resolveAfterValidation({
      itemId: item.id, revision: envelope.revision, correctionHash: envelope.correctionHash,
      evidenceHash: 'c'.repeat(64), resolvedBy: 'op',
    });
    const retry = approveAndAdvanceItems({
      itemIds: [item.id], batchId: batch.id, approvedBy: 'op', requestHash: 'e'.repeat(64),
    });
    expect(retry.rejected.some((r) => r.itemId === item.id && r.reason === 'preparation_gap_unresolved')).toBe(false);
  });

  it('fail-closed integrity: fake URL, foreign attempt, stale generation, bad version, hash mismatch', async () => {
    seedConnections();
    approveAcana();
    const { item } = seedItem();
    const registry = new TestRegistry();
    registry.register('dist_phillips', new MockConnector('dist_phillips', { name: 'Acana Adult Dog', description: 'Specs' }));
    registry.register('dist_bci', new MockConnector('dist_bci', { name: 'Acana Adult Dog', description: 'Specs' }));
    const generation = startSourcingGeneration(item.id);
    const engine = new DefaultSourcingEngine(registry);
    await engine.runGeneration({
      itemId: item.id, generationId: generation.id, workspaceId, upc: '012345678905',
      brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });
    // A distributor contribution carrying a URL is never a valid envelope
    // (contribution-level parse guard — never a fake official URL).
    expect(buildStrategyCollectionEnvelope({
      itemId: item.id, generationId: generation.id, strategyRevision: 1, strategyBrand: 'acana',
      sources: [{ kind: 'distributor_record', distributorId: 'dist_phillips' }],
      attempts: [{
        attemptId: 'a1', connectionId: 'c1', distributorId: 'dist_phillips',
        providerId: 'provider_dist_phillips', outcome: 'found', identityJson: null,
      }],
      unavailableDistributorIds: [], identityConflict: false,
    })).not.toBeNull();
    // ...while a contribution-level fake URL fails closed at parse.
    expect(buildStrategyCollectionResult({
      itemId: item.id, sourcingGenerationId: generation.id, strategyRevision: 1, strategyBrand: 'acana',
      contributions: [{
        kind: 'distributor_record', connectionId: 'c1', providerId: 'provider_x',
        attemptIds: ['a1'], sourceUrl: 'https://fake.example/p', outcome: 'success', fields: {},
      }],
    })).toBeNull();

    const finalized = finalizeStrategyCollectionForGeneration({ workspaceId, itemId: item.id, generationId: generation.id });
    expect(finalized.envelope.version).toBe('strategy-collection-v1');

    // Tampered version fails closed on read.
    getDb().query("UPDATE strategy_collection_results SET version = 'strategy-collection-v999' WHERE sourcing_generation_id = ?").run(generation.id);
    expect(() => getStrategyCollectionResult(generation.id)).toThrow(/unsupported_version/);

    // Foreign attempt id smuggled into the envelope fails closed.
    getDb().query("UPDATE strategy_collection_results SET version = 'strategy-collection-v1', contributions_json = ? WHERE sourcing_generation_id = ?")
      .run(JSON.stringify([{ kind: 'distributor_record', connectionId: null, providerId: 'provider_x', attemptIds: ['foreign-attempt'], sourceUrl: null, outcome: 'success', fields: {} }]), generation.id);
    expect(() => getStrategyCollectionResult(generation.id)).toThrow(/unknown_attempt|corrupt/);

    // Stale generation: supersede, then finalize on the old generation fails.
    const gen2 = supersedeCurrentSourcingGeneration(item.id, 'operator_retry');
    expect(getCurrentSourcingGeneration(item.id)?.id).toBe(gen2.id);
    expect(() => finalizeStrategyCollectionForGeneration({ workspaceId, itemId: item.id, generationId: generation.id }))
      .toThrow(/stale_generation/);

    // Missing envelope reads fail closed with a stable code.
    expect(() => getStrategyCollectionResult(gen2.id)).toThrow(/missing_envelope/);
    void finalized;
  });

  it('lifecycle: frozen approval survives later Saves; retry captures anew; live mutations do not move the pin', async () => {
    seedConnections();
    approveAcana([{ kind: 'distributor_record', distributorId: 'dist_phillips' }]);
    const { item } = seedItem();
    const registry = new TestRegistry();
    registry.register('dist_phillips', new MockConnector('dist_phillips', { name: 'Acana Adult Dog', description: 'Specs' }));
    registry.register('dist_bci', new MockConnector('dist_bci', { name: 'Acana Adult Dog', description: 'Specs' }));
    const generation = startSourcingGeneration(item.id);
    const engine = new DefaultSourcingEngine(registry);
    await engine.runGeneration({
      itemId: item.id, generationId: generation.id, workspaceId, upc: '012345678905',
      brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });
    const finalized = finalizeStrategyCollectionForGeneration({ workspaceId, itemId: item.id, generationId: generation.id });
    expect(finalized.envelope.strategyRevision).toBe(1);

    // Save revision 2 mid-flight: the finalized envelope stays pinned to rev 1.
    saveBrandStrategy(workspaceId, {
      brand: 'Acana',
      sources: [
        { kind: 'distributor_record', distributorId: 'dist_phillips' },
        { kind: 'distributor_record', distributorId: 'dist_bci' },
      ],
      expectedRevision: 1,
    });
    expect(getStrategyCollectionResult(generation.id).envelope.strategyRevision).toBe(1);

    // Disabling the live connection does not move the frozen pin either.
    const conns = getDb().query('SELECT id FROM distributor_connections WHERE workspace_id = ?').all(workspaceId) as Array<{ id: string }>;
    for (const c of conns) updateConnection(c.id, workspaceId, { enabled: false });
    expect(getStrategyCollectionResult(generation.id).envelope.strategyRevision).toBe(1);

    // Explicit retry in a new generation captures the newest approval.
    const gen2 = supersedeCurrentSourcingGeneration(item.id, 'operator_retry');
    for (const c of conns) updateConnection(c.id, workspaceId, { enabled: true });
    await engine.runGeneration({
      itemId: item.id, generationId: gen2.id, workspaceId, upc: '012345678905',
      brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });
    const finalized2 = finalizeStrategyCollectionForGeneration({ workspaceId, itemId: item.id, generationId: gen2.id });
    expect(finalized2.envelope.strategyRevision).toBe(2);
    expect(finalized2.envelope.contributions.filter((c) => c.outcome === 'success')).toHaveLength(2);
  });

  it('read surface: finalized envelope is visible per source; missing envelope reads null', async () => {
    seedConnections();
    approveAcana();
    const { item } = seedItem();
    const registry = new TestRegistry();
    registry.register('dist_phillips', new MockConnector('dist_phillips', { name: 'Acana Adult Dog', description: 'Specs' }));
    registry.register('dist_bci', new MockConnector('dist_bci', null, 'not_stocked'));
    const generation = startSourcingGeneration(item.id);
    const engine = new DefaultSourcingEngine(registry);
    await engine.runGeneration({
      itemId: item.id, generationId: generation.id, workspaceId, upc: '012345678905',
      brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });
    finalizeStrategyCollectionForGeneration({ workspaceId, itemId: item.id, generationId: generation.id });
    const app = new Hono();
    app.route('/api', strategyCollectionRoutes);
    const res = await app.request(`/api/onboarding/strategy-collections/by-item/${item.id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      envelope: { contributions: Array<{ kind: string; providerId: string; outcome: string; sourceUrl: string | null }> } | null;
      hash: string | null;
    };
    expect(body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.envelope?.contributions.map((c) => c.outcome).sort()).toEqual(['no_match', 'success']);
    for (const c of body.envelope?.contributions ?? []) expect(c.sourceUrl).toBeNull();
    // Item with no finalized envelope reads null (never a synthesized fallback).
    const { item: other } = seedItem('012345678907');
    const res2 = await app.request(`/api/onboarding/strategy-collections/by-item/${other.id}`);
    expect(res2.status).toBe(200);
    expect(((await res2.json()) as { envelope: unknown }).envelope).toBeNull();
  });
});

describe('ticket #122: P1 hardening — write-once, materializer, worker routing', () => {
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

  async function runEngine(distributors: Array<{ id: string; profile: FieldProfile | null; outcome?: 'found' | 'not_stocked' | 'source_error' }>, upc = '012345678905') {
    const { item } = seedItem(upc);
    const registry = new TestRegistry();
    for (const d of distributors) registry.register(d.id, new MockConnector(d.id, d.profile, d.outcome ?? 'found'));
    const generation = startSourcingGeneration(item.id);
    const engine = new DefaultSourcingEngine(registry);
    const result = await engine.runGeneration({
      itemId: item.id, generationId: generation.id, workspaceId, upc,
      brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });
    return { item, generation, result };
  }

  it('write-once: identical re-finalize is idempotent; divergent attempts conflict', async () => {
    seedConnections();
    approveAcana();
    const { item, generation, result } = await runEngine([
      { id: 'dist_phillips', profile: { name: 'Acana Adult Dog', description: null } },
      { id: 'dist_bci', profile: { name: null, description: 'Complete nutrition' } },
    ]);
    expect(result.attempts).toHaveLength(2);
    const first = finalizeStrategyCollectionForGeneration({ workspaceId, itemId: item.id, generationId: generation.id });
    expect(first.idempotent).toBe(false);
    const second = finalizeStrategyCollectionForGeneration({ workspaceId, itemId: item.id, generationId: generation.id });
    expect(second.idempotent).toBe(true);
    expect(second.hash).toBe(first.hash);
    // Divergent durable evidence (an attempt outcome changes after
    // finalization) can never silently rewrite the envelope.
    const attemptId = result.attempts[0].attemptId;
    getDb().query(`UPDATE onboarding_evidence_attempts SET outcome = 'source_error', error_code = 'timeout' WHERE id = ?`).run(attemptId);
    expect(() => finalizeStrategyCollectionForGeneration({ workspaceId, itemId: item.id, generationId: generation.id }))
      .toThrow(/envelope_conflict/);
    // The stored envelope itself is untouched by the conflict.
    expect(getStrategyCollectionResult(generation.id).hash).toBe(first.hash);
  });

  it('materializer consolidates compatible contributions; retry is idempotent; wrong hash and missing envelope fail closed', async () => {
    seedConnections();
    approveAcana();
    const { item, generation, result } = await runEngine([
      { id: 'dist_phillips', profile: { name: 'Acana Adult Dog', description: null } },
      { id: 'dist_bci', profile: { name: null, description: 'Complete nutrition' } },
    ]);
    const finalized = finalizeStrategyCollectionForGeneration({ workspaceId, itemId: item.id, generationId: generation.id });
    const attemptIds = result.attempts.map((a) => a.attemptId).sort();
    const providers = result.attempts.map((a) => a.providerId).sort();
    recordAcceptances(item.id, attemptIds, 'system', 'test qualified');
    const completed = completeSourcingWithDecision(
      item.id,
      strategyDecision(generation.id, attemptIds, providers, finalized.hash),
      'collect_details',
    );
    expect(completed.ok).toBe(true);
    updateItemStageStatus(item.id, 'in_progress');

    const first = materializeStrategyCollectionExtraction(item.id, workspaceId);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.idempotent).toBe(false);
      expect(first.extractionData.sourceUrl).toBeNull();
      // Complementary attribution survives consolidation.
      expect(first.extractionData.fieldProvenance).toMatchObject({ title: 'provider_dist_phillips', description: 'provider_dist_bci' });
      const row = getDb().query(`SELECT extraction_method, source_url FROM onboarding_extractions WHERE id = ?`)
        .get(first.extractionId) as { extraction_method: string; source_url: string | null };
      expect(row.extraction_method).toBe('strategy_collection_v1');
      expect(row.source_url).toBeNull();
      expect(findItemById(item.id)?.stageStatus).toBe('completed');
    }
    // Idempotent retry reuses the stored row (a worker re-claim flips the
    // item back to in_progress before re-running materialization).
    updateItemStageStatus(item.id, 'in_progress');
    const retry = materializeStrategyCollectionExtraction(item.id, workspaceId);
    expect(retry.ok).toBe(true);
    if (retry.ok && first.ok) {
      expect(retry.idempotent).toBe(true);
      expect(retry.extractionId).toBe(first.extractionId);
    }
  });

  it('materializer completed-empty branch preserves imported evidence; never fabricates distributor evidence', async () => {
    seedConnections();
    approveAcana();
    const { item, generation, result } = await runEngine([
      { id: 'dist_phillips', profile: null, outcome: 'not_stocked' },
      { id: 'dist_bci', profile: null, outcome: 'not_stocked' },
    ]);
    expect(result.attempts).toHaveLength(2);
    const finalized = finalizeStrategyCollectionForGeneration({ workspaceId, itemId: item.id, generationId: generation.id });
    const completed = completeSourcingWithDecision(
      item.id,
      strategyDecision(generation.id, [], [], finalized.hash),
      'collect_details',
    );
    expect(completed.ok).toBe(true);
    updateItemStageStatus(item.id, 'in_progress');
    const materialized = materializeStrategyCollectionExtraction(item.id, workspaceId);
    expect(materialized.ok).toBe(true);
    if (materialized.ok) {
      const data = materialized.extractionData;
      expect(data.sourceUrl).toBeNull();
      expect(data.distributorEvidenceAttemptIds).toEqual([]);
      // Safe imported evidence fills the gap, attributed as imported.
      expect(data.importedEvidence).toMatchObject({ title: true, brand: true, description: true });
      expect(data.fieldProvenance).toMatchObject({ title: 'imported_evidence', brand: 'imported_evidence' });
      expect(data.title).toBe('Acana Food');
      expect(data.brand).toBe('Acana');
    }
  });

  it('materializer fails closed on hash mismatch and missing envelope', async () => {
    seedConnections();
    approveAcana();
    // Hash mismatch: decision carries a well-formed but wrong envelope hash.
    const { item, generation, result } = await runEngine([
      { id: 'dist_phillips', profile: { name: 'Acana Adult Dog', description: 'Specs' } },
      { id: 'dist_bci', profile: { name: 'Acana Adult Dog', description: 'Specs' } },
    ]);
    finalizeStrategyCollectionForGeneration({ workspaceId, itemId: item.id, generationId: generation.id });
    const attemptIds = result.attempts.map((a) => a.attemptId).sort();
    const providers = result.attempts.map((a) => a.providerId).sort();
    recordAcceptances(item.id, attemptIds, 'system', 'test');
    const wrongHash = completeSourcingWithDecision(
      item.id,
      strategyDecision(generation.id, attemptIds, providers, 'f'.repeat(64)),
      'collect_details',
    );
    expect(wrongHash.ok).toBe(true);
    updateItemStageStatus(item.id, 'in_progress');
    const mismatched = materializeStrategyCollectionExtraction(item.id, workspaceId);
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.code).toBe('hash_mismatch');

    // Missing envelope: attempts exist but nothing was ever finalized.
    const { item: item2 } = seedItem('012345678906');
    const registry = new TestRegistry();
    registry.register('dist_phillips', new MockConnector('dist_phillips', { name: 'Acana Adult Dog', description: 'Specs' }));
    registry.register('dist_bci', new MockConnector('dist_bci', { name: 'Acana Adult Dog', description: 'Specs' }));
    const gen2 = startSourcingGeneration(item2.id);
    const engine = new DefaultSourcingEngine(registry);
    const result2 = await engine.runGeneration({
      itemId: item2.id, generationId: gen2.id, workspaceId, upc: '012345678906',
      brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    });
    const attemptIds2 = result2.attempts.map((a) => a.attemptId).sort();
    const providers2 = result2.attempts.map((a) => a.providerId).sort();
    recordAcceptances(item2.id, attemptIds2, 'system', 'test');
    const completed2 = completeSourcingWithDecision(
      item2.id,
      strategyDecision(gen2.id, attemptIds2, providers2, 'e'.repeat(64)),
      'collect_details',
    );
    expect(completed2.ok).toBe(true);
    updateItemStageStatus(item2.id, 'in_progress');
    const missing = materializeStrategyCollectionExtraction(item2.id, workspaceId);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('missing_envelope');
  });

  it('incomplete mixed without an official attempt fails closed (never synthesized)', () => {
    // Ticket #123 lifted the old mixed-boundary rejection: mixed sources
    // build envelopes once every planned source has a terminal attempt.
    // A planned official domain with NO attempt is interrupted work — the
    // builder returns null (finalization owns incomplete_collection).
    expect(buildStrategyCollectionEnvelope({
      itemId: 'item-1', generationId: 'gen-1', strategyRevision: 1, strategyBrand: 'acana',
      sources: [
        { kind: 'distributor_record', distributorId: 'dist_phillips' },
        { kind: 'official_page', domain: 'acme.com' },
      ],
      attempts: [],
      unavailableDistributorIds: ['dist_phillips'],
      identityConflict: false,
    })).toBeNull();
  });

  it('worker routes approved distributor-only sourcing to Collect details without Discovery', async () => {
    seedConnections();
    approveAcana();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracer-worker-'));
    const wsPath = path.join(tmp, 'ws');
    fs.mkdirSync(path.join(wsPath, '.baystate-cms'), { recursive: true });
    const exhaustedUpc = '012345678921';
    const foundUpc = '012345678922';
    const batch = createBatch({ workspaceId, name: 'worker-b', fileName: 'worker.csv', totalItems: 2 });
    const [exhaustedItem] = insertItems(
      batch.id,
      [{ upc: exhaustedUpc, name: 'Exhausted Food', brandHint: 'Acana', rowNumber: 1, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );
    const [foundItem] = insertItems(
      batch.id,
      [{ upc: foundUpc, name: 'Found Food', brandHint: 'Acana', rowNumber: 2, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );
    const registry = new TestRegistry();
    // Phillips finds only the found UPC; BCI stocks neither. Found records
    // carry no catalog version, so projection never qualifies: both items
    // must take the completed-envelope route, never Discovery.
    registry.register('dist_phillips', new MockConnector('dist_phillips', { name: 'Acana Adult Dog', description: 'Specs' }, 'found', new Set([foundUpc])));
    registry.register('dist_bci', new MockConnector('dist_bci', null, 'not_stocked'));
    const worker = new OnboardingWorker(workspaceId, wsPath, 10, 3, () => new DefaultSourcingEngine(registry));
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    try {
      await worker.poll();
      await worker.drain();
    } finally {
      resetSourcingFlagsOverride();
    }
    const exhaustedAfter = findItemById(exhaustedItem.id)!;
    const foundAfter = findItemById(foundItem.id)!;
    // Never Discovery: distributor-only work stays inside Collect details
    // (stored as the v1 'extraction' literal — compare canonically).
    for (const after of [exhaustedAfter, foundAfter]) {
      expect(after.stage).not.toBe('find_product_page');
      expect(after.stage).not.toBe('discovery');
      expect(toCanonicalStored(after.stage)).toBe('collect_details');
    }
    // Exhausted: started collection, zero acceptances, completed envelope.
    const exhaustedDecision = exhaustedAfter.sourcingDecision as { route: string; evidenceHash: string; acceptedEvidenceAttemptIds: string[] } | null;
    expect(exhaustedDecision?.route).toBe('completed_strategy_collection');
    expect(exhaustedDecision?.acceptedEvidenceAttemptIds).toEqual([]);
    const exhaustedGeneration = getCurrentSourcingGeneration(exhaustedItem.id);
    expect(exhaustedGeneration?.id).toBeTruthy();
    expect(exhaustedDecision?.evidenceHash).toBe(getStrategyCollectionResult(exhaustedGeneration!.id).hash);
    // Found-and-qualified: the pre-existing qualified contract is preserved
    // (not weakened for the strategy path) — same Collect details target.
    const foundDecision = foundAfter.sourcingDecision as { route: string; evidenceHash: string; acceptedEvidenceAttemptIds: string[] } | null;
    expect(foundDecision?.route).toBe('distributor_record_to_extraction');
    expect(foundDecision?.acceptedEvidenceAttemptIds).toHaveLength(1);
    expect(foundDecision?.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
