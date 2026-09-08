import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  findItemById,
} from '../../db/repositories/onboarding-item-repo';
import {
  startSourcingGeneration,
  insertEvidenceAttempt,
} from '../../db/repositories/onboarding-evidence-repo';
import { getAcceptedAttemptIdsForItem } from '../../db/repositories/onboarding-acceptance-repo';
import { createDistributor, createConnection } from '../../db/repositories/distributor-repo';
import { OnboardingWorker } from '../../onboarding/job-queue';
import { getLatestDiscoveryRunForItem } from '../../db/repositories/onboarding-source-repo';
import { onboardingEvents } from '../../onboarding/sse-emitter';
import { overrideSourcingFlags, resetSourcingFlagsOverride } from '../../onboarding/flags';
import { SOURCING_ENTRY_POLICY_VERSION } from '../../onboarding/sourcing/entry-policy';
import type { SourcingDecisionV2 } from '../../shared/schemas/onboarding';
import type { Workspace } from '../../shared/types';

describe('Sourcing worker pass-through (ADR 0014 flag-gated leg)', () => {
  let tempDir: string;
  let dbPath: string;
  let workspaceId: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcing-pass-through-test-'));
    dbPath = path.join(tempDir, 'test.db');
    initDb(dbPath);
    runMigrations();
    overrideSourcingFlags({ sourcingEngineEnabled: true });

    workspaceId = 'ws-pass-through';
    const ws: Workspace = {
      id: workspaceId,
      name: 'Test Workspace',
      workspacePath: tempDir,
      gitPath: path.join(tempDir, '.git'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    };
    insertWorkspace(ws);
  });

  afterEach(() => {
    resetSourcingFlagsOverride();
    closeDb();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function makeSourcingItem(upc = '012345678901', name = 'Pass Through Item') {
    const batch = createBatch({ workspaceId, name: 'PT Batch', fileName: 'pt.csv', totalItems: 1 });
    // Post-Amendment-A (Milestone B): worker-claimable sourcing fixtures must
    // carry the current entry-policy version (1). Version 0 = legacy stranded
    // rows, which the worker never claims.
    const [item] = insertItems(batch.id, [{ upc, name, rowNumber: 1, stage: 'sourcing' }], 'sourcing', SOURCING_ENTRY_POLICY_VERSION);
    return item;
  }

  function seedAttempt(itemId: string, upc: string, generationId: string, outcome: 'found' | 'not_stocked' | 'source_error', identityJson: string | null, providerId = 'p1') {
    return insertEvidenceAttempt({
      itemId,
      providerId,
      lookupUpc: upc,
      outcome,
      confidence: outcome === 'found' ? 0.9 : 0,
      evidenceUrl: null,
      matchedFields: outcome === 'found' ? ['upc', 'weight'] : [],
      identityJson,
      warningsJson: null,
      errorCode: outcome === 'source_error' ? 'timeout' : null,
      errorMessage: outcome === 'source_error' ? 'provider timed out' : null,
      sourcingGenerationId: generationId,
    });
  }

  test('flag OFF: sourcing items are never claimed and stay sourcing/pending', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: false });
    const item = makeSourcingItem();

    const worker = new OnboardingWorker(workspaceId, tempDir);
    await worker.poll();

    const after = findItemById(item.id);
    expect(after?.stage).toBe('sourcing');
    expect(after?.stageStatus).toBe('pending');
    expect(after?.sourceUrl).toBeNull();

    const generations = getDb().query('SELECT * FROM sourcing_generations WHERE item_id = ?').all(item.id);
    expect(generations.length).toBe(0);
  });

  test('flag ON + 0 enabled connections: audited automatic pass-through to discovery', async () => {
    const item = makeSourcingItem();

    const worker = new OnboardingWorker(workspaceId, tempDir);
    await worker.poll();

    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    // The same poll re-claims the completed item into the Discovery stage, so
    // the status may be pending (source leg settled) or in_progress (the
    // discovery promise is still in flight when poll() returns).
    expect(['pending', 'in_progress']).toContain(after?.stageStatus ?? '');
    expect(after?.sourcingDecision?.route).toBe('fallback_to_discovery');
    expect(after?.sourcingDecision?.origin).toBe('automatic_policy');
    expect(after?.sourcingDecision?.warnings).toContain('No enabled distributor connections');
  });

  test('flag ON + pre-seeded all not_stocked: fallback to discovery (engine not invoked)', async () => {
    const item = makeSourcingItem();
    const gen = startSourcingGeneration(item.id, 'automatic');
    seedAttempt(item.id, item.upc, gen.id, 'not_stocked', null);

    const worker = new OnboardingWorker(workspaceId, tempDir);
    await worker.poll();

    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(['pending', 'in_progress']).toContain(after?.stageStatus ?? '');
    expect(after?.sourcingDecision?.route).toBe('fallback_to_discovery');
    // Only the ONE seeded attempt exists (the engine never ran).
    const attempts = getDb().query('SELECT * FROM onboarding_evidence_attempts WHERE item_id = ?').all(item.id) as unknown[];
    expect(attempts.length).toBe(1);
  });

  test('flag ON + pre-seeded coherent found evidence: evidence_to_discovery + acceptances', async () => {
    const item = makeSourcingItem();
    const gen = startSourcingGeneration(item.id, 'automatic');

    const att1 = seedAttempt(item.id, item.upc, gen.id, 'found', JSON.stringify({ brand: 'Brand A', weight: '10 lbs' }), 'phillips');
    const att2 = seedAttempt(item.id, item.upc, gen.id, 'found', JSON.stringify({ brand: 'Brand A', weight: '10 lbs' }), 'unfi');

    const worker = new OnboardingWorker(workspaceId, tempDir);
    await worker.poll();

    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(['pending', 'in_progress']).toContain(after?.stageStatus ?? '');
    expect(after?.sourcingDecision?.route).toBe('evidence_to_discovery');
    expect(after?.sourcingDecision?.origin).toBe('automatic_policy');
    expect(after?.sourcingDecision?.acceptedEvidenceAttemptIds).toEqual(
      expect.arrayContaining([att1.id, att2.id]),
    );

    const accepted = getAcceptedAttemptIdsForItem(item.id);
    expect(accepted).toContain(att1.id);
    expect(accepted).toContain(att2.id);
  });

  test('flag ON + distributor discrepancy: auto-resolves and routes to discovery with warnings', async () => {
    const item = makeSourcingItem();
    const gen = startSourcingGeneration(item.id, 'automatic');

    seedAttempt(item.id, item.upc, gen.id, 'found', JSON.stringify({ brand: 'Brand A', weight: '10 lbs' }), 'phillips');
    seedAttempt(item.id, item.upc, gen.id, 'found', JSON.stringify({ brand: 'Brand A', weight: '20 lbs' }), 'unfi');

    const worker = new OnboardingWorker(workspaceId, tempDir);
    await worker.poll();

    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(['pending', 'in_progress']).toContain(after?.stageStatus ?? '');
    expect(after?.sourcingDecision?.route).toBe('evidence_to_discovery');
    expect(after?.sourcingDecision?.origin).toBe('automatic_policy');
    expect(after?.sourcingDecision?.warnings?.some((w) => w.includes('auto-resolved'))).toBe(true);
  });

  test('flag ON: discovery claiming still happens (other stages unaffected)', async () => {
    const batch = createBatch({ workspaceId, name: 'Unknown Brand', fileName: 'unknown.xlsx', totalItems: 1 });
    const [item] = insertItems(batch.id, [
      { upc: '012345678999', name: 'Mystery Widget', brandHint: 'Unknown Brand', rowNumber: 1 },
    ]);
    expect(item.stage).toBe('discovery');

    const worker = new OnboardingWorker(workspaceId, tempDir);
    await worker.poll();

    // Discovery leg claimed the item and completed deterministically offline:
    // the brand has no mapped official domain, so discovery parks it at
    // needs_input_setup (stage stays discovery, status completed).
    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.stageStatus).toBe('completed');

    // The hold is specifically the missing-domain setup hold — not the
    // generic no-candidates outcome — and nothing was persisted as a source.
    const run = getLatestDiscoveryRunForItem(item.id);
    expect(run?.outcome).toBe('needs_input_setup');
    expect(run?.outcome_message ?? '').toContain('official domain');
    const sourceRows = getDb()
      .query('SELECT COUNT(*) AS c FROM onboarding_sources WHERE item_id = ?')
      .get(item.id) as { c: number };
    expect(sourceRows.c).toBe(0);
  });

  test('emits EXACTLY ONE terminal event per outcome (completed, never a duplicate failed)', async () => {
    const batch = createBatch({ workspaceId, name: 'SSE Batch', fileName: 'sse.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678930', name: 'SSE Item', rowNumber: 1, stage: 'sourcing' }], 'sourcing', SOURCING_ENTRY_POLICY_VERSION);
    const gen = startSourcingGeneration(item.id, 'automatic');
    seedAttempt(item.id, item.upc, gen.id, 'not_stocked', null, 'phillips');

    const events: Array<{ status: string; stage?: string; route?: string }> = [];
    const unsubscribe = onboardingEvents.subscribe(batch.id, (e) => {
      events.push({ status: String(e.data.status), stage: e.data.stage as string, route: e.data.route as string });
    });

    const worker = new OnboardingWorker(workspaceId, tempDir);
    await worker.poll();
    unsubscribe();

    const terminal = events.filter((e) => ['completed', 'failed', 'needs_input'].includes(e.status));
    expect(terminal.length).toBe(1);
    expect(terminal[0]).toMatchObject({ status: 'completed', stage: 'route_sources', route: 'fallback_to_discovery' });
  });

  test('emits exactly one completed event for auto-resolved match and advances', async () => {
    const batch = createBatch({ workspaceId, name: 'SSE Conflict Batch', fileName: 'ssec.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678931', name: 'SSE Conflict', rowNumber: 1, stage: 'sourcing' }], 'sourcing', SOURCING_ENTRY_POLICY_VERSION);
    const gen = startSourcingGeneration(item.id, 'automatic');
    seedAttempt(item.id, item.upc, gen.id, 'found', JSON.stringify({ brand: 'A', weight: '10 lbs' }), 'phillips');
    seedAttempt(item.id, item.upc, gen.id, 'found', JSON.stringify({ brand: 'A', weight: '20 lbs' }), 'unfi');

    const events: Array<{ status: string; stage?: string }> = [];
    const unsubscribe = onboardingEvents.subscribe(batch.id, (e) => {
      events.push({ status: String(e.data.status), stage: e.data.stage as string });
    });

    const worker = new OnboardingWorker(workspaceId, tempDir);
    await worker.poll();
    unsubscribe();

    const terminal = events.filter((e) => ['completed', 'failed', 'needs_input'].includes(e.status));
    expect(terminal.length).toBe(1);
    expect(terminal[0].status).toBe('completed');
    expect(findItemById(item.id)?.stage).toBe('discovery');
  });

  // ── Amendment A distributor routing (MC) — inside the shared fixture scope.

  function makeConnection(providerId: string) {
    createDistributor({ id: providerId, name: providerId, status: 'active' });
    return createConnection({ workspaceId, distributorId: providerId, connectorType: 'api' });
  }

  function seedQualifiedAttempt(itemId: string, upc: string, generationId: string, providerId: string, identity: Record<string, unknown> = {}) {
    const conn = makeConnection(providerId);
    return insertEvidenceAttempt({
      itemId,
      providerId,
      distributorConnectionId: conn.id,
      lookupUpc: upc,
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc', 'name'],
      identityJson: JSON.stringify({
        upc,
        name: 'Pet Kibble 5lb',
        brand: 'Brand A',
        weight: '10 lbs',
        ...identity,
      }),
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      catalogVersion: 'v2026.3',
      observedAt: '2026-08-13T00:00:00.000Z',
      sourcingGenerationId: generationId,
    });
  }

  test('automatic mode + qualified found evidence routes to EXTRACTION (distributor_record), source_url stays null', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const item = makeSourcingItem();
    const gen = startSourcingGeneration(item.id, 'automatic');
    const att = seedQualifiedAttempt(item.id, item.upc, gen.id, 'phillips');

    const worker = new OnboardingWorker(workspaceId, tempDir);
    await worker.poll();

    const after = findItemById(item.id);
    expect(after?.stage).toBe('extraction');
    expect(after?.sourceType).toBe('distributor_record');
    expect(after?.sourceUrl).toBeNull();
    // V2 decision shape (typed local — the read union narrows per access).
    const decision = after?.sourcingDecision as Extract<
      SourcingDecisionV2,
      { route: 'distributor_record_to_extraction' }
    > | null | undefined;
    expect(decision?.route).toBe('distributor_record_to_extraction');
    expect(decision?.schemaVersion).toBe(2);
    expect(decision?.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(decision?.acceptedEvidenceAttemptIds).toEqual([att.id]);
    expect(decision?.sourceType).toBe('distributor_record');
    expect(decision?.target).toBe('extraction');

    const accepted = getAcceptedAttemptIdsForItem(item.id);
    expect(accepted).toContain(att.id);
  });

  test('automatic mode + qualified found: the route is FOLLOWED by distributor-record Extraction completion (fixture connectors)', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const item = makeSourcingItem();
    const gen = startSourcingGeneration(item.id, 'automatic');
    seedQualifiedAttempt(item.id, item.upc, gen.id, 'phillips');

    const worker = new OnboardingWorker(workspaceId, tempDir);
    // Poll 1: Sourcing routes the qualified item to extraction/pending.
    await worker.poll();
    await worker.drain();
    const routed = findItemById(item.id);
    expect(routed?.stage).toBe('extraction');
    expect(routed?.stageStatus).toBe('pending');
    expect(routed?.sourceType).toBe('distributor_record');
    expect(routed?.sourceUrl).toBeNull();
    // No extraction row yet — Sourcing only ROUTES; Extraction materializes.
    const rowsBefore = getDb().query('SELECT * FROM onboarding_extractions WHERE item_id = ?').all(item.id) as unknown[];
    expect(rowsBefore.length).toBe(0);

    // Poll 2: Extraction claims and materializes the distributor record.
    await worker.poll();
    await worker.drain();
    const after = findItemById(item.id);
    expect(after?.stage).toBe('extraction');
    expect(after?.stageStatus).toBe('completed');
    expect(after?.extractionData?.sourceType).toBe('distributor_record');
    expect(after?.extractionData?.title).toBe('Pet Kibble 5lb');
    expect(after?.extractionData?.description).toBeNull();
    expect(after?.extractionData?.price).toBeNull();
    expect(after?.extractionData?.primaryImage).toBeNull();
    expect(after?.extractionData?.sourceUrl).toBeNull();

    const rows = getDb().query('SELECT * FROM onboarding_extractions WHERE item_id = ?').all(item.id) as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0].extraction_method).toBe('distributor_record_v2');
    expect(rows[0].source_type).toBe('distributor_record');
    expect(rows[0].source_url).toBeNull();
    expect(rows[0].sourcing_generation_id).toBe(gen.id);
    expect(String(rows[0].evidence_hash)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('distributor integrity failure stays extraction/failed and is never retried as an official page', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const item = makeSourcingItem();
    const gen = startSourcingGeneration(item.id, 'automatic');
    seedQualifiedAttempt(item.id, item.upc, gen.id, 'phillips');

    const worker = new OnboardingWorker(workspaceId, tempDir);
    // Poll 1: Sourcing routes the qualified item to extraction/pending and
    // writes the authoritative V2 decision.
    await worker.poll();
    await worker.drain();
    const routed = findItemById(item.id);
    expect(routed?.stage).toBe('extraction');
    expect(routed?.stageStatus).toBe('pending');

    // Corrupt the decision hash AFTER routing, BEFORE extraction materializes:
    // the materializer recheck must fail closed (hash_mismatch) and the
    // worker must leave the item extraction/failed — never falling through to
    // the official-page URL/profile path.
    const routedDecision = routed?.sourcingDecision as SourcingDecisionV2;
    getDb().query('UPDATE onboarding_items SET sourcing_decision_json = ? WHERE id = ?').run(
      JSON.stringify({ ...routedDecision, evidenceHash: 'f'.repeat(64) }),
      item.id,
    );

    // Poll 2: Extraction claims and materializes → integrity failure.
    await worker.poll();
    await worker.drain();

    const after = findItemById(item.id);
    expect(after?.stage).toBe('extraction');
    expect(after?.stageStatus).toBe('failed');
    expect(after?.errorMessage).toContain('distributor_materialization:hash_mismatch');
    // Never treated as an official page: no URL was set, no extraction row.
    expect(after?.sourceUrl).toBeNull();
    const rows = getDb().query('SELECT * FROM onboarding_extractions WHERE item_id = ?').all(item.id) as unknown[];
    expect(rows.length).toBe(0);
  });

  test('automatic mode + qualified found WITH another provider error: uses the qualified record (warning retained, extraction)', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const item = makeSourcingItem();
    const gen = startSourcingGeneration(item.id, 'automatic');
    seedQualifiedAttempt(item.id, item.upc, gen.id, 'phillips');
    seedAttempt(item.id, item.upc, gen.id, 'source_error', null, 'unfi');

    const worker = new OnboardingWorker(workspaceId, tempDir);
    await worker.poll();

    const after = findItemById(item.id);
    expect(after?.stage).toBe('extraction');
    expect(after?.sourcingDecision?.route).toBe('distributor_record_to_extraction');
    expect(after?.sourceUrl).toBeNull();
    // MC review fix: the provider-error warning MUST be retained in the
    // decision audit alongside the qualified record.
    const warnings = after?.sourcingDecision?.warnings ?? [];
    expect(warnings.some((w) => w.includes('unfi') && w.includes('timeout'))).toBe(true);
  });

  test('automatic mode + found below the qualification floor (no name): evidence_to_discovery, never extraction', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const item = makeSourcingItem();
    const gen = startSourcingGeneration(item.id, 'automatic');
    seedAttempt(item.id, item.upc, gen.id, 'found', JSON.stringify({ upc: item.upc, brand: 'Brand A', weight: '10 lbs' }), 'phillips');

    const worker = new OnboardingWorker(workspaceId, tempDir);
    await worker.poll();

    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.sourcingDecision?.route).toBe('evidence_to_discovery');
  });

  test('manual mode + qualified found evidence HOLDS at sourcing/needs_input (never advanced)', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'manual' });
    const item = makeSourcingItem();
    const gen = startSourcingGeneration(item.id, 'automatic');
    const att = seedQualifiedAttempt(item.id, item.upc, gen.id, 'phillips');

    const worker = new OnboardingWorker(workspaceId, tempDir);
    await worker.poll();

    const after = findItemById(item.id);
    expect(after?.stage).toBe('sourcing');
    expect(after?.stageStatus).toBe('needs_input');
    expect(after?.sourcingDecision?.route).toBe('needs_input_conflict');
    expect(after?.sourcingDecision?.providerIds).toContain('phillips');
    // MC review fix: the manual hold persists RELATIONAL acceptances so the
    // server can recompute qualification when the operator chooses
    // "Use distributor record" (the V2 needs_input decision cannot carry ids).
    expect(getAcceptedAttemptIdsForItem(item.id)).toEqual([att.id]);
    const extractionCount = getDb().query('SELECT COUNT(*) AS c FROM onboarding_extractions WHERE item_id = ?').get(item.id) as { c: number };
    expect(extractionCount.c).toBe(0);
  });

  test('manual mode end-to-end: worker hold → acceptances → use_distributor_record completes to extraction/pending', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'manual' });
    const item = makeSourcingItem();
    const gen = startSourcingGeneration(item.id, 'automatic');
    seedQualifiedAttempt(item.id, item.upc, gen.id, 'phillips');

    const worker = new OnboardingWorker(workspaceId, tempDir);
    await worker.poll();

    const held = findItemById(item.id);
    expect(held?.stage).toBe('sourcing');
    expect(held?.stageStatus).toBe('needs_input');
    // Relational acceptances persisted by the manual worker path.
    expect(getAcceptedAttemptIdsForItem(item.id).length).toBeGreaterThan(0);

    // The strict manual action recomputes qualification from the relational
    // acceptances and routes to Extraction (marker-v1 distributor record).
    const { completeSourcingViaProjection } = await import('../../db/repositories/onboarding-item-repo');
    const result = completeSourcingViaProjection(item.id, [], { strictQualification: true });
    expect(result.ok).toBe(true);
    expect(result.qualified).toBe(true);
    expect(result.route).toBe('distributor_record_to_extraction');
    expect(result.evidenceHash).toMatch(/^[0-9a-f]{64}$/);

    const completed = findItemById(item.id);
    expect(completed?.stage).toBe('extraction');
    expect(completed?.stageStatus).toBe('pending');
    expect(completed?.sourceType).toBe('distributor_record');
    expect(completed?.sourceUrl).toBeNull();
  });
});
