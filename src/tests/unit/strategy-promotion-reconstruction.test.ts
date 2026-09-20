/**
 * Strategy-collection promotion provenance: reconstruction authority.
 *
 * The strategy route must verify both the durable row and the live item
 * payload against a deterministic reconstruction from the validated envelope
 * + decision binding — not just against each other. Two matching-but-wrong
 * copies (both tampered identically) must still fail closed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems, findItemById, completeSourcingWithDecision, updateItemStageStatus } from '../../db/repositories/onboarding-item-repo';
import { recordAcceptances } from '../../db/repositories/onboarding-acceptance-repo';
import { startSourcingGeneration } from '../../db/repositories/onboarding-evidence-repo';
import { createDistributor, createConnection, updateConnection } from '../../db/repositories/distributor-repo';
import { saveBrandStrategy } from '../../db/repositories/brand-strategy-approval-repo';
import { DefaultSourcingEngine } from '../../onboarding/sourcing/engine';
import type { ConnectorRegistry } from '../../onboarding/sourcing/connector-registry';
import type { DistributorConnector, SourcingLookupRequest, SourcingLookupResult } from '../../onboarding/sourcing/contracts';
import { finalizeStrategyCollectionForGeneration } from '../../db/repositories/strategy-collection-result-repo';
import { materializeStrategyCollectionExtraction, reconstructStrategyCollectionExtractionPayload, payloadsEquivalentForDistributorRecord } from '../../onboarding/sourcing/distributor-record-materializer';
import { computePromotionGate } from '../../onboarding/draft-promoter';
import { getStrategyCollectionResult } from '../../db/repositories/strategy-collection-result-repo';

type FieldProfile = { name: string | null; description: string | null; brand?: string | null; weight?: string | null };

class MockConnector implements DistributorConnector {
  readonly connectorType = 'api';
  readonly requiresSecret = false;
  readonly providerId: string;
  constructor(readonly distributorId: string, private readonly profile: FieldProfile | null) {
    this.providerId = `provider_${distributorId}`;
  }
  async lookupByGtin(request: SourcingLookupRequest): Promise<SourcingLookupResult> {
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

const workspaceId = 'ws-strategy-promotion-recon';

beforeEach(() => {
  initDb(':memory:');
  runMigrations();
  insertWorkspace({
    id: workspaceId,
    name: 'Recon WS',
    workspacePath: '/tmp/test-strategy-recon',
    gitPath: '/tmp/test-strategy-recon/.git',
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

async function seedStrategyItem(upc = '012345678905') {
  seedConnections();
  saveBrandStrategy(workspaceId, {
    brand: 'Acana',
    sources: [
      { kind: 'distributor_record', distributorId: 'dist_phillips' },
      { kind: 'distributor_record', distributorId: 'dist_bci' },
    ],
    expectedRevision: 0,
    approvedBy: 'test',
  });
  const batch = createBatch({ workspaceId, name: 'b', fileName: 'b.csv', totalItems: 1 });
  const [item] = insertItems(batch.id, [{ upc, name: 'Acana Food', brandHint: 'Acana', rowNumber: 1 }], 'route_sources', 1);
  const registry = new TestRegistry();
  registry.register('dist_phillips', new MockConnector('dist_phillips', { name: 'Acana Adult Dog', description: null }));
  registry.register('dist_bci', new MockConnector('dist_bci', { name: null, description: 'Complete nutrition' }));
  const generation = startSourcingGeneration(item.id);
  const engine = new DefaultSourcingEngine(registry);
  const result = await engine.runGeneration({
    itemId: item.id, generationId: generation.id, workspaceId, upc,
    brandHint: 'Acana', signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10000).toISOString(),
  });
  const finalized = finalizeStrategyCollectionForGeneration({ workspaceId, itemId: item.id, generationId: generation.id });
  const attemptIds = result.attempts.map((a) => a.attemptId).sort();
  const providers = result.attempts.map((a) => a.providerId).sort();
  recordAcceptances(item.id, attemptIds, 'system', 'test');
  const decision = {
    schemaVersion: 2 as const,
    route: 'completed_strategy_collection' as const,
    origin: 'automatic_policy' as const,
    acceptedEvidenceAttemptIds: attemptIds,
    providerIds: providers,
    sourcingGenerationId: generation.id,
    evidenceHash: finalized.hash,
    sourceType: 'distributor_record' as const,
    target: 'extraction' as const,
    conflicts: [],
    warnings: [],
    decidedAt: new Date().toISOString(),
  };
  const completed = completeSourcingWithDecision(item.id, decision, 'collect_details');
  expect(completed.ok).toBe(true);
  updateItemStageStatus(item.id, 'in_progress');
  const materialized = materializeStrategyCollectionExtraction(item.id, workspaceId);
  expect(materialized.ok).toBe(true);
  return { batch, itemId: item.id, generationId: generation.id, upc };
}

describe('strategy promotion reconstruction authority', () => {
  it('valid strategy materialization passes the promotion gate', async () => {
    const { itemId } = await seedStrategyItem();
    const item = findItemById(itemId)!;
    // Legacy path (no run pointer) isolates the distributor gate.
    expect(item.curationData?.classificationRunId).toBeUndefined();
    const gate = computePromotionGate(item, workspaceId, null);
    expect(gate.ok).toBe(true);
  });

  it('identical tamper of both durable row and live payload still blocks (reconstruction authority)', async () => {
    const { itemId } = await seedStrategyItem();
    const db = getDb();
    const tamperedDescription = 'Identically tampered description on both copies.';
    for (const table of ['onboarding_extractions', 'onboarding_items'] as const) {
      const col = table === 'onboarding_extractions' ? 'extraction_data_json' : 'extraction_data_json';
      const where = table === 'onboarding_extractions' ? 'item_id = ?' : 'id = ?';
      const row = db.query(`SELECT ${col} FROM ${table} WHERE ${where}`).get(itemId) as Record<string, string>;
      const payload = JSON.parse(row[col]) as Record<string, unknown>;
      payload.description = tamperedDescription;
      db.query(`UPDATE ${table} SET ${col} = ? WHERE ${where}`).run(JSON.stringify(payload), itemId);
    }
    const item = findItemById(itemId)!;
    const gate = computePromotionGate(item, workspaceId, null);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('Distributor promotion blocked');
    expect(gate.reason).toContain('row tampered');
  });

  it('single-side item payload tamper blocks with item-payload reason', async () => {
    const { itemId } = await seedStrategyItem('012345678906');
    const db = getDb();
    const row = db.query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(itemId) as { extraction_data_json: string };
    const payload = JSON.parse(row.extraction_data_json) as Record<string, unknown>;
    payload.description = 'Item-only tamper.';
    db.query('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?').run(JSON.stringify(payload), itemId);
    const gate = computePromotionGate(findItemById(itemId)!, workspaceId, null);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('item payload tampered');
  });

  it('OCR execution bookkeeping on the live payload still passes', async () => {
    const { itemId } = await seedStrategyItem('012345678907');
    const db = getDb();
    const row = db.query('SELECT extraction_data_json FROM onboarding_items WHERE id = ?').get(itemId) as { extraction_data_json: string };
    const payload = JSON.parse(row.extraction_data_json) as Record<string, unknown>;
    payload.ocrOutcome = { status: 'no_image', imageCount: 0 };
    payload.ocrInputHash = 'a'.repeat(64);
    payload.ocrExecutionDigest = 'b'.repeat(64);
    db.query('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?').run(JSON.stringify(payload), itemId);
    const gate = computePromotionGate(findItemById(itemId)!, workspaceId, null);
    expect(gate.ok).toBe(true);
  });

  it('pure reconstruction matches the materialized payload and rejects identical tamper', async () => {
    const { itemId, generationId } = await seedStrategyItem('012345678908');
    const item = findItemById(itemId)!;
    const { envelope, hash } = getStrategyCollectionResult(generationId);
    const expected = reconstructStrategyCollectionExtractionPayload({
      itemName: item.name,
      brandHint: item.brandHint,
      generationId,
      acceptedAttemptIds: (item.sourcingDecision as { acceptedEvidenceAttemptIds: string[] }).acceptedEvidenceAttemptIds,
      envelope,
      evidenceHash: hash,
    });
    expect(payloadsEquivalentForDistributorRecord(item.extractionData as Record<string, unknown>, expected)).toBe(true);
    const tampered = { ...expected, description: 'Tampered.' };
    expect(payloadsEquivalentForDistributorRecord(tampered, expected)).toBe(false);
  });
});
