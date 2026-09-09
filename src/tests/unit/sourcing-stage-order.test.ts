import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  findItemById,
  listItemsByBatchStaged,
  advanceItemsToNextStage,
  updateSourcingDecision,
  updateItemStageStatus,
  fallbackSourcingItemsToDiscovery,
  completeSourcingWithDecision,
  resetItemsForRetry,
} from '../../db/repositories/onboarding-item-repo';
import {
  startSourcingGeneration,
  insertEvidenceAttempt,
  listGenerationsForItem,
} from '../../db/repositories/onboarding-evidence-repo';
import { upsertBrandSite, findBrandSites } from '../../db/repositories/brand-site-repo';
import { OnboardingWorker } from '../../onboarding/job-queue';
import { overrideSourcingFlags, resetSourcingFlagsOverride } from '../../onboarding/flags';
import { SOURCING_ENTRY_POLICY_VERSION } from '../../onboarding/sourcing/entry-policy';
import type { Workspace } from '../../shared/types';

describe('Sourcing Stage Order & Capability-Gated Entry (Issue #44)', () => {
  let tempDir: string;
  let dbPath: string;
  let workspaceId: string;

  beforeEach(() => {
    overrideSourcingFlags({ sourcingEngineEnabled: false });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcing-order-test-'));
    dbPath = path.join(tempDir, 'test.db');
    initDb(dbPath);
    runMigrations();

    workspaceId = 'ws-test-sourcing';
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

  it('defaults newly imported spreadsheet items to stage=discovery and stageStatus=pending (engine disabled)', () => {
    const batch = createBatch({
      workspaceId,
      name: 'New Import Batch',
      fileName: 'products.xlsx',
      totalItems: 2,
    });

    // Caller-selected entry stage: the disabled-engine policy is Discovery,
    // so no import can strand at sourcing/pending.
    const items = insertItems(batch.id, [
      { upc: '012345678901', name: 'Pet Kibble Small 5lb', brandHint: 'Acme Pet', rowNumber: 1 },
      { upc: '012345678902', name: 'Pet Kibble Large 20lb', brandHint: 'Acme Pet', rowNumber: 2 },
    ]);

    expect(items.length).toBe(2);
    expect(items[0].stage).toBe('discovery');
    expect(items[0].stageStatus).toBe('pending');
    expect(items[1].stage).toBe('discovery');
    expect(items[1].stageStatus).toBe('pending');
  });

  it('an explicit sourcing fixture remains possible and the worker never claims it', async () => {
    // Historical/repair fixtures may still construct sourcing rows directly;
    // the worker must never claim them (no sourcing leg exists).
    upsertBrandSite('Acme Pet', 'acmepet.com');
    const sites = findBrandSites('Acme Pet');
    expect(sites.length).toBe(1);
    expect(sites[0].domain).toBe('acmepet.com');

    const batch = createBatch({
      workspaceId,
      name: 'Recognized Brand Import',
      fileName: 'known-brand.xlsx',
      totalItems: 1,
    });

    const items = insertItems(batch.id, [
      { upc: '012345678903', name: 'Acme Dog Treats', brandHint: 'Acme Pet', rowNumber: 1, stage: 'sourcing' },
    ]);

    expect(items[0].stage).toBe('sourcing');
    expect(items[0].stageStatus).toBe('pending');

    // 3. Run worker polling loop
    const worker = new OnboardingWorker(workspaceId, tempDir);
    await worker.poll();

    // Verify item remains unclaimed and untouched in Sourcing
    const itemAfterPoll = findItemById(items[0].id);
    expect(itemAfterPoll?.stage).toBe('sourcing');
    expect(itemAfterPoll?.stageStatus).toBe('pending');
    expect(itemAfterPoll?.sourceUrl).toBeNull();
  });

  it('disabled-mode imports land in discovery/pending and the worker claims them', async () => {
    const batch = createBatch({
      workspaceId,
      name: 'Unknown Brand Import',
      fileName: 'unknown-brand.xlsx',
      totalItems: 1,
    });

    const items = insertItems(batch.id, [
      { upc: '012345678904', name: 'Mystery Widget', brandHint: 'Unknown Brand', rowNumber: 1 },
    ]);

    expect(items[0].stage).toBe('discovery');
    expect(items[0].stageStatus).toBe('pending');

    const worker = new OnboardingWorker(workspaceId, tempDir);
    await worker.poll();

    // The Discovery leg CLAIMS pending discovery rows and settles them
    // deterministically offline: with a brand hint but no mapped domain the
    // preflight halts at needs_input_setup, which parks the item as
    // discovery/completed with a needsManualReview flag — a supported
    // review state, not stranding. No retry bookkeeping occurs because
    // offline discovery never throws.
    const itemAfterPoll = findItemById(items[0].id);
    expect(itemAfterPoll?.stage).toBe('discovery');
    expect(itemAfterPoll?.stageStatus).toBe('completed');
    expect(itemAfterPoll?.retryCount).toBe(0);
  });

  it('advances every completed Sourcing item to Discovery only (legacy bundle decisions ignored)', () => {
    const batch = createBatch({
      workspaceId,
      name: 'Stage Advancement Test',
      fileName: 'test.xlsx',
      totalItems: 2,
    });

    const items = insertItems(batch.id, [
      { upc: '012345678905', name: 'Item 1 Fallback', rowNumber: 1, stage: 'sourcing' },
      { upc: '012345678906', name: 'Item 2 Legacy Bundle', rowNumber: 2, stage: 'sourcing' },
    ]);

    // Complete sourcing stage for Item 1 (fallback to discovery)
    updateItemStageStatus(items[0].id, 'completed');
    const advResult1 = advanceItemsToNextStage([items[0].id]);
    expect(advResult1.advanced).toBe(1);

    const item1After = findItemById(items[0].id);
    expect(item1After?.stage).toBe('discovery');
    expect(item1After?.stageStatus).toBe('pending');

    // Legacy persisted bundle decision for Item 2 — routing ignores it:
    // Sourcing → Curation is prohibited; advancement targets Discovery only.
    updateSourcingDecision(items[1].id, {
      route: 'bundle_to_curation',
      origin: 'operator_override',
      acceptedEvidenceAttemptIds: ['attempt-1'],
      providerIds: [],
      conflicts: [],
      warnings: [],
      decidedAt: new Date().toISOString(),
    });
    updateItemStageStatus(items[1].id, 'completed');

    const advResult2 = advanceItemsToNextStage([items[1].id]);
    expect(advResult2.advanced).toBe(1);

    const item2After = findItemById(items[1].id);
    expect(item2After?.stage).toBe('discovery');
    expect(item2After?.stageStatus).toBe('pending');
  });

  it('repairs stranded sourcing/pending rows to discovery with an audited decision', () => {
    const batch = createBatch({
      workspaceId,
      name: 'Batch Staged Test',
      fileName: 'staged.xlsx',
      totalItems: 2,
    });

    const items = insertItems(batch.id, [
      { upc: '012345678907', name: 'Stranded Item', rowNumber: 1, stage: 'sourcing' },
      { upc: '012345678908', name: 'Already Advancing Item', rowNumber: 2, stage: 'sourcing' },
    ]);
    // One row already completed sourcing (not part of the stranded cohort).
    updateItemStageStatus(items[1].id, 'completed');

    const staged = listItemsByBatchStaged(batch.id);
    expect(staged.route_sources.length).toBe(2);

    const res = fallbackSourcingItemsToDiscovery([items[0].id, items[1].id]);
    expect(res.moved).toEqual([items[0].id]);
    expect(res.skipped[0]).toEqual({ id: items[1].id, reason: 'not_eligible:sourcing/completed' });

    const moved = findItemById(items[0].id);
    expect(moved?.stage).toBe('discovery');
    expect(moved?.stageStatus).toBe('pending');
    expect(moved?.sourcingDecision?.route).toBe('fallback_to_discovery');
    expect(moved?.sourcingDecision?.origin).toBe('operator_override');
    // Transition clears error/claim/retry state (no worker involved here).
    expect(moved?.retryCount).toBe(0);
    expect(moved?.errorMessage).toBeNull();
  });

  it('completeSourcingWithDecision enforces the ADR 0014 route/target matrix', () => {
    const batch = createBatch({
      workspaceId,
      name: 'Matrix Batch',
      fileName: 'matrix.csv',
      totalItems: 1,
    });
    const [item] = insertItems(batch.id, [
      { upc: '012345678910', name: 'Matrix Item', rowNumber: 1, stage: 'sourcing' },
    ]);
    const now = new Date().toISOString();
    const decision = (route: string) => ({
      route,
      origin: 'automatic_policy',
      acceptedEvidenceAttemptIds: [] as string[],
      providerIds: [] as string[],
      conflicts: [] as unknown[],
      warnings: [] as string[],
      decidedAt: now,
    });

    // bundle_to_curation is prohibited — the helper refuses it outright.
    expect(
      completeSourcingWithDecision(item.id, decision('bundle_to_curation') as never, 'find_product_page'),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('prohibited') });

    // Route/target mismatch fails closed.
    expect(
      completeSourcingWithDecision(item.id, decision('evidence_to_discovery') as never, 'route_sources'),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('targets find_product_page') });

    // needs_input_conflict requires the item to be in needs_input.
    expect(
      completeSourcingWithDecision(item.id, decision('needs_input_conflict') as never, 'route_sources'),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('needs_input') });

    // retry_provider_errors stays in route_sources/pending (target 'route_sources').
    expect(
      completeSourcingWithDecision(item.id, decision('retry_provider_errors') as never, 'route_sources'),
    ).toEqual({ ok: true });
    const retryItem = findItemById(item.id);
    expect(retryItem?.stage).toBe('sourcing');
    expect(retryItem?.stageStatus).toBe('pending');

    // needs_input_conflict on a needs_input item keeps route_sources/needs_input (stored v1 spelling).
    updateItemStageStatus(item.id, 'needs_input', 'conflict');
    expect(
      completeSourcingWithDecision(item.id, decision('needs_input_conflict') as never, 'route_sources'),
    ).toEqual({ ok: true });
    expect(findItemById(item.id)?.stageStatus).toBe('needs_input');

    // A row in a different stage cannot be completed through the helper.
    const [otherItem] = insertItems(batch.id, [
      { upc: '012345678911', name: 'Other Stage', rowNumber: 2, stage: 'discovery' },
    ]);
    expect(
      completeSourcingWithDecision(otherItem.id, decision('evidence_to_discovery') as never, 'find_product_page'),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('not_eligible') });
  });

  it('engine-ON retry stays in Sourcing and supersedes the evidence generation', () => {
    const batch = createBatch({
      workspaceId,
      name: 'Retry Batch',
      fileName: 'retry.csv',
      totalItems: 1,
    });
    const [item] = insertItems(
      batch.id,
      [{ upc: '012345678912', name: 'Retry Item', rowNumber: 1, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );
    const gen1 = startSourcingGeneration(item.id, 'automatic');
    insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'phillips',
      lookupUpc: item.upc,
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: null,
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      sourcingGenerationId: gen1.id,
    });

    const res = resetItemsForRetry([item.id], { sourcingEngineEnabled: true });
    expect(res.reset).toContain(item.id);
    expect(res.moved).toEqual([]);

    const after = findItemById(item.id);
    expect(after?.stage).toBe('sourcing'); // stays in Sourcing, never stranded
    expect(after?.stageStatus).toBe('pending');

    // The old generation is superseded; a fresh one exists for the re-run.
    const generations = listGenerationsForItem(item.id);
    expect(generations.length).toBe(2);
    expect(generations[0].status).toBe('superseded');
    expect(generations[1].supersedesId).toBe(generations[0].id);
    expect(generations[1].status).toBe('running');
  });
describe('Sourcing stage order — Amendment A rollout modes (MC)', () => {
  it('automatic mode: marker-v1 sourcing items are claimed and routed (zero connections → fallback to discovery)', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const batch = createBatch({ workspaceId, name: 'Auto Batch', fileName: 'auto.csv', totalItems: 1 });
    const [item] = insertItems(
      batch.id,
      [{ upc: '012345678920', name: 'Auto Item', rowNumber: 1, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );

    const worker = new OnboardingWorker(workspaceId, tempDir);
    await worker.poll();

    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.sourcingDecision?.route).toBe('fallback_to_discovery');
  });

  it('manual mode: marker-v1 sourcing items are claimed but every non-conflict outcome HOLDS at needs_input', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'manual' });
    const batch = createBatch({ workspaceId, name: 'Manual Batch', fileName: 'manual.csv', totalItems: 1 });
    const [item] = insertItems(
      batch.id,
      [{ upc: '012345678921', name: 'Manual Item', rowNumber: 1, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );

    const worker = new OnboardingWorker(workspaceId, tempDir);
    await worker.poll();

    const after = findItemById(item.id);
    // Claimed (status changed) but NOT advanced — the operator chooses.
    expect(after?.stage).toBe('sourcing');
    expect(after?.stageStatus).toBe('needs_input');
    expect(after?.sourcingDecision?.route).toBe('needs_input_conflict');
  });

  it('observe mode: sourcing is never in the auto stage list — marker-v1 sourcing rows stay pending', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'observe' });
    const batch = createBatch({ workspaceId, name: 'Observe Batch', fileName: 'observe.csv', totalItems: 1 });
    const [item] = insertItems(
      batch.id,
      [{ upc: '012345678922', name: 'Observe Item', rowNumber: 1, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );

    const worker = new OnboardingWorker(workspaceId, tempDir);
    await worker.poll();

    const after = findItemById(item.id);
    expect(after?.stage).toBe('sourcing');
    expect(after?.stageStatus).toBe('pending');
    expect(after?.sourcingDecision).toBeNull();
  });

  it('invalid mode (effective disabled): sourcing is never claimed', async () => {
    overrideSourcingFlags({
      sourcingEngineEnabled: true,
      mode: 'invalid' as unknown as 'automatic',
    });
    const batch = createBatch({ workspaceId, name: 'Invalid Batch', fileName: 'invalid.csv', totalItems: 1 });
    const [item] = insertItems(
      batch.id,
      [{ upc: '012345678923', name: 'Invalid Item', rowNumber: 1, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );

    const worker = new OnboardingWorker(workspaceId, tempDir);
    await worker.poll();

    const after = findItemById(item.id);
    expect(after?.stage).toBe('sourcing');
    expect(after?.stageStatus).toBe('pending');
  });

  it('marker-v0 rows are never claimed even in automatic mode (operator Continue path preserved)', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const batch = createBatch({ workspaceId, name: 'V0 Batch', fileName: 'v0.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [
      { upc: '012345678924', name: 'Legacy Item', rowNumber: 1, stage: 'sourcing' },
    ]);

    const worker = new OnboardingWorker(workspaceId, tempDir);
    await worker.poll();

    const after = findItemById(item.id);
    expect(after?.stage).toBe('sourcing');
    expect(after?.stageStatus).toBe('pending');
    expect(after?.sourcingDecision).toBeNull();
  });
});
});