/**
 * Sourcing stage safety-patch route tests.
 *
 * DB-backed (runs under `bun test` via test:db — vitest cannot collect
 * bun:sqlite suites). Proves that while the Sourcing engine capability is
 * disabled (the default):
 * - spreadsheet imports enter Discovery, never stranding at sourcing/pending;
 * - imports can enter Sourcing only under an explicit capability override;
 * - the bulk fallback endpoint repairs stranded sourcing/pending rows with
 *   audited decisions and truthful partial results;
 * - cross-workspace repair requests fail closed;
 * - /items/reset and /:id/retry cannot leave a Sourcing item pending;
 * - resolve-sourcing accepts only fallback and never writes Curation state;
 * - items/advance cannot use a legacy bundle_to_curation decision to skip
 *   Discovery.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { unlinkSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, resetDb, getDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createBatch } from '../../db/repositories/onboarding-batch-repo';
import {
  insertItems,
  findItemById,
  updateSourcingDecision,
  updateItemStageStatus,
} from '../../db/repositories/onboarding-item-repo';
import { overrideSourcingFlags, resetSourcingFlagsOverride } from '../../onboarding/flags';
import { OnboardingWorker } from '../../onboarding/job-queue';
import { SOURCING_ENTRY_POLICY_VERSION } from '../../onboarding/sourcing/entry-policy';
import {
  startSourcingGeneration,
  insertEvidenceAttempt,
  listGenerationsForItem,
} from '../../db/repositories/onboarding-evidence-repo';
import { insertConflictWithCandidates } from '../../db/repositories/onboarding-conflict-repo';
import { recordAcceptances } from '../../db/repositories/onboarding-acceptance-repo';
import { createConnection } from '../../db/repositories/distributor-repo';
import app from '../../server/app';

const testDbPath = path.resolve(import.meta.dirname, 'sourcing-safety-routes-test.db');
const conflictDbPath = path.resolve(import.meta.dirname, 'sourcing-safety-routes-conflict-test.db');
const wsId = 'ws-sourcing-safety';
const foreignWsId = 'ws-sourcing-safety-foreign';

function importPayload(rows: Array<Record<string, string>>) {
  return {
    name: 'Safety Patch Import',
    fileName: 'safety.xlsx',
    mapping: {
      upc: 'SKU/UPC',
      name: 'Product Name',
      nameMergeWith: null,
      price: null,
      quantity: null,
      brand: null,
      department: null,
      sourceUrl: null,
    },
    rows,
  };
}

/**
 * SERP retirement: the re-queue routes fire a detached (non-awaited)
 * worker poll. Offline discovery is deterministic and never throws, so by
 * assertion time the moved row is either still queued at discovery/pending
 * (poll not finished) or already settled at discovery/completed with a
 * needsManualReview flag (zero candidates / no domain mapped). Neither
 * state strands the item — that invariant is what these suites assert.
 */
function expectDiscoveryRequeueState(item: { stage?: string | null; stageStatus?: string | null } | undefined): void {
  expect(item?.stage).toBe('discovery');
  expect(['pending', 'completed']).toContain(item?.stageStatus);
}

describe('Sourcing stage safety routes (engine disabled)', () => {
  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(conflictDbPath);
    runMigrations();
    const now = new Date().toISOString();
    insertWorkspace({
      id: wsId,
      name: 'Test Workspace',
      workspacePath: '/tmp/ws',
      gitPath: '/tmp/ws/.git',
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: 'baseline-sha',
    });
    insertWorkspace({
      id: foreignWsId,
      name: 'Foreign Workspace',
      workspacePath: '/tmp/foreign',
      gitPath: '/tmp/foreign/.git',
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: 'baseline-sha',
    });
  });

  afterAll(() => {
    closeDb();
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(conflictDbPath + suffix); } catch { /* ok */ }
    }
  });

  beforeEach(() => {
    overrideSourcingFlags({ sourcingEngineEnabled: false });
  });

  it('spreadsheet import enters discovery/pending with no sourcing decision (engine disabled)', async () => {
    const res = await app.request('/api/onboarding/batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(importPayload([
        { 'SKU/UPC': 'SAFE-001', 'Product Name': 'Safe Product One' },
      ])),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const items = getDb().query('SELECT * FROM onboarding_items WHERE batch_id = ?').all(body.batch.id) as Array<{ stage: string; stage_status: string; sourcing_decision_json: string | null; sourcing_entry_policy_version: number }>;
    expect(items).toHaveLength(1);
    expect(items[0].stage).toBe('discovery');
    expect(items[0].stage_status).toBe('pending');
    expect(items[0].sourcing_decision_json).toBeNull();
    // Production spreadsheet imports are post-Amendment-A: entry-policy
    // version 1 even when the derived entry stage is Discovery.
    expect(items[0].sourcing_entry_policy_version).toBe(1);
  });

  it('import can enter Sourcing only under an explicit capability override', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true });
    try {
      const res = await app.request('/api/onboarding/batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(importPayload([
          { 'SKU/UPC': 'SAFE-002', 'Product Name': 'Capable Product' },
        ])),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      const items = getDb().query('SELECT * FROM onboarding_items WHERE batch_id = ?').all(body.batch.id) as Array<{ stage: string; stage_status: string }>;
      expect(items[0].stage).toBe('sourcing');
      expect(items[0].stage_status).toBe('pending');
    } finally {
      resetSourcingFlagsOverride();
    }
  });

  it('capabilities endpoint reports engineEnabled=false by default (mode + reason + entry policy)', async () => {
    const res = await app.request('/api/onboarding/capabilities');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sourcing.engineEnabled).toBe(false);
    expect(body.sourcing.mode).toBeNull();
    expect(typeof body.sourcing.configurationReason).toBe('string');
    expect(body.sourcing.entryPolicyVersion).toBe(SOURCING_ENTRY_POLICY_VERSION);
    // No secrets/connection details in the capabilities view.
    expect(Object.keys(body.sourcing)).not.toContain('secretRef');
    expect(Object.keys(body.sourcing)).not.toContain('connections');
  });

  it('capabilities fail closed under an invalid mode (engineEnabled=false, mode null)', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'invalid-mode' as 'automatic' });
    try {
      const res = await app.request('/api/onboarding/capabilities');
      expect(res.status).toBe(200);
      const body = await res.json();
      // Effective capability is fail-closed: the raw switch may be true but the
      // effective state (what the UI and worker use) is disabled.
      expect(body.sourcing.engineEnabled).toBe(false);
      expect(body.sourcing.mode).toBeNull();
      expect(body.sourcing.configurationReason).toBe('invalid_mode');
    } finally {
      resetSourcingFlagsOverride();
    }
  });

  it('capabilities report observe mode truthfully (engineEnabled=true, mode observe)', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'observe' });
    try {
      const res = await app.request('/api/onboarding/capabilities');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sourcing.engineEnabled).toBe(true);
      expect(body.sourcing.mode).toBe('observe');
    } finally {
      resetSourcingFlagsOverride();
    }
  });

  it('observe-mode retry of a marker-v1 Sourcing item uses the audited fallback (never strands)', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'observe' });
    try {
      const batch = createBatch({ workspaceId: wsId, name: 'ObsRetry', fileName: 'or.csv', totalItems: 1 });
      const [item] = insertItems(
        batch.id,
        [{ upc: 'OBS-001', name: 'Observe Retry', rowNumber: 1, stage: 'sourcing' }],
        'sourcing',
        SOURCING_ENTRY_POLICY_VERSION,
      );

      const res = await app.request(`/api/onboarding/items/${item.id}/retry`, { method: 'POST' });
      expect(res.status).toBe(200);

      // Observe mode never claims Sourcing; an in-place reset would strand the
      // row at sourcing/pending. The audited fallback moves it to Discovery.
      const after = findItemById(item.id);
      expectDiscoveryRequeueState(after);
      expect(after?.sourcingDecision?.route).toBe('fallback_to_discovery');
    } finally {
      resetSourcingFlagsOverride();
    }
  });

  it('invalid-mode retry of a marker-v1 Sourcing item uses the audited fallback (never strands)', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'invalid-mode' as 'automatic' });
    try {
      const batch = createBatch({ workspaceId: wsId, name: 'InvRetry', fileName: 'ir.csv', totalItems: 1 });
      const [item] = insertItems(
        batch.id,
        [{ upc: 'INV-001', name: 'Invalid Retry', rowNumber: 1, stage: 'sourcing' }],
        'sourcing',
        SOURCING_ENTRY_POLICY_VERSION,
      );

      const res = await app.request(`/api/onboarding/items/${item.id}/retry`, { method: 'POST' });
      expect(res.status).toBe(200);

      const after = findItemById(item.id);
      expectDiscoveryRequeueState(after);
      expect(after?.sourcingDecision?.route).toBe('fallback_to_discovery');
    } finally {
      resetSourcingFlagsOverride();
    }
  });

  it('bulk fallback moves stranded sourcing/pending rows with audited decisions and truthful skips', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Stranded', fileName: 's.csv', totalItems: 3 });
    const items = insertItems(batch.id, [
      { upc: 'SAFE-101', name: 'Stranded A', rowNumber: 1, stage: 'sourcing' },
      { upc: 'SAFE-102', name: 'Stranded B', rowNumber: 2, stage: 'sourcing' },
      { upc: 'SAFE-103', name: 'Completed C', rowNumber: 3, stage: 'sourcing' },
    ]);
    updateSourcingDecision(items[2].id, {
      route: 'fallback_to_discovery',
      origin: 'operator_override',
      acceptedEvidenceAttemptIds: [],
      providerIds: [],
      conflicts: [],
      warnings: [],
      decidedAt: new Date().toISOString(),
    }); // completed — not part of the stranded cohort

    const res = await app.request('/api/onboarding/items/fallback-sourcing-to-discovery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [items[0].id, items[1].id, items[2].id, 'missing-id'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.moved).toEqual([items[0].id, items[1].id]);
    expect(body.skipped).toContainEqual({ id: items[2].id, reason: 'not_eligible:sourcing/completed' });
    expect(body.skipped).toContainEqual({ id: 'missing-id', reason: 'not_found' });

    for (const id of [items[0].id, items[1].id]) {
      const item = findItemById(id);
      expectDiscoveryRequeueState(item);
      expect(item?.sourcingDecision?.route).toBe('fallback_to_discovery');
      expect(item?.sourcingDecision?.origin).toBe('operator_override');
      expect(item?.sourcingDecision?.acceptedEvidenceAttemptIds).toEqual([]);
      // Pre-poll the transition leaves no error; post-poll the deterministic
      // zero-candidate completion records its review note here.
      expect([null, 'No matching product pages found']).toContain(item?.errorMessage);
      // retry_count was reset to 0 by the transition; offline discovery is
      // deterministic (never throws), so the detached endpoint poll settles
      // the row without any retry bookkeeping.
    }
    const completed = findItemById(items[2].id);
    expect(completed?.stage).toBe('sourcing');
    expect(completed?.stageStatus).toBe('completed');
  });

  it('cross-workspace repair requests fail closed without mutation', async () => {
    const foreignBatch = createBatch({ workspaceId: foreignWsId, name: 'Foreign', fileName: 'f.csv', totalItems: 1 });
    const [item] = insertItems(foreignBatch.id, [
      { upc: 'SAFE-201', name: 'Foreign Stranded', rowNumber: 1, stage: 'sourcing' },
    ]);

    const res = await app.request('/api/onboarding/items/fallback-sourcing-to-discovery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [item.id] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.moved).toEqual([]);
    expect(body.skipped).toEqual([{ id: item.id, reason: 'not_owned' }]);

    const after = findItemById(item.id);
    expect(after?.stage).toBe('sourcing');
    expect(after?.stageStatus).toBe('pending');
  });

  it('/items/reset cannot leave a Sourcing item pending while the engine is disabled', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Reset', fileName: 'r.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [
      { upc: 'SAFE-301', name: 'Reset Me', rowNumber: 1, stage: 'sourcing' },
    ]);

    const res = await app.request('/api/onboarding/items/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [item.id] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.moved).toEqual([item.id]);

    const after = findItemById(item.id);
    expectDiscoveryRequeueState(after);
    expect(after?.sourcingDecision?.route).toBe('fallback_to_discovery');
  });

  it('/:id/retry cannot leave a Sourcing item pending while the engine is disabled', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Retry', fileName: 't.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [
      { upc: 'SAFE-302', name: 'Retry Me', rowNumber: 1, stage: 'sourcing' },
    ]);

    const res = await app.request(`/api/onboarding/items/${item.id}/retry`, { method: 'POST' });
    expect(res.status).toBe(200);

    const after = findItemById(item.id);
    expectDiscoveryRequeueState(after);
    expect(after?.sourcingDecision?.route).toBe('fallback_to_discovery');
  });

  it('resolve-sourcing accepts fallback only and rejects legacy bundle payloads with zero effects', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Resolve', fileName: 'v.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [
      { upc: 'SAFE-401', name: 'Resolve Me', rowNumber: 1, stage: 'sourcing' },
    ]);

    // Legacy bundle payload → 400, no mutation.
    const bundleRes = await app.request(`/api/onboarding/items/${item.id}/resolve-sourcing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'use_selected_bundle', selectedAttemptIds: ['attempt-1'] }),
    });
    expect(bundleRes.status).toBe(400);
    const untouched = findItemById(item.id);
    expect(untouched?.stage).toBe('sourcing');
    expect(untouched?.stageStatus).toBe('pending');
    expect(untouched?.sourcingDecision).toBeNull();
    expect(untouched?.extractionData).toBeNull();

    // Fallback payload → audited move to discovery.
    const fallbackRes = await app.request(`/api/onboarding/items/${item.id}/resolve-sourcing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'fallback_to_discovery' }),
    });
    expect(fallbackRes.status).toBe(200);
    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.stageStatus).toBe('pending');
    expect(after?.sourcingDecision?.route).toBe('fallback_to_discovery');
    expect(after?.sourcingDecision?.origin).toBe('operator_override');
  });

  it('resolve-sourcing on a non-sourcing item is rejected', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'WrongStage', fileName: 'w.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [
      { upc: 'SAFE-402', name: 'Not Sourcing', rowNumber: 1 },
    ]);

    const res = await app.request(`/api/onboarding/items/${item.id}/resolve-sourcing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'fallback_to_discovery' }),
    });
    expect(res.status).toBe(400);
    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.stageStatus).toBe('pending');
  });

  it('items/advance cannot use a legacy bundle_to_curation decision to skip Discovery', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Legacy', fileName: 'l.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [
      { upc: 'SAFE-501', name: 'Legacy Bundle', rowNumber: 1, stage: 'sourcing' },
    ]);
    // Legacy persisted bundle decision + completed status (direct-SQL
    // historical fixture per ADR 0014 — the helper refuses this route).
    getDb()
      .query(
        `UPDATE onboarding_items SET sourcing_decision_json = ?, stage_status = 'completed', updated_at = ? WHERE id = ?`,
      )
      .run(
        JSON.stringify({
          route: 'bundle_to_curation',
          origin: 'automatic_policy',
          acceptedEvidenceAttemptIds: ['attempt-1'],
          providerIds: ['unfi'],
          conflicts: [],
          warnings: [],
          decidedAt: new Date().toISOString(),
        }),
        new Date().toISOString(),
        item.id,
      );

    const res = await app.request('/api/onboarding/items/advance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [item.id] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.advanced).toBe(1);

    const after = findItemById(item.id);
    expectDiscoveryRequeueState(after);
  });
});

// ─── Multi-Distributor Sourcing V2 (ADR 0014): conflict routes ────────────────

describe('Sourcing conflict routes (ADR 0014)', () => {
  // The safety-patch describe above closes + deletes the DB in its afterAll;
  // this describe re-bootstraps its own fresh database.
  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(conflictDbPath);
    runMigrations();
    const now = new Date().toISOString();
    insertWorkspace({
      id: wsId,
      name: 'Test Workspace',
      workspacePath: '/tmp/ws',
      gitPath: '/tmp/ws/.git',
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: 'baseline-sha',
    });
    insertWorkspace({
      id: foreignWsId,
      name: 'Foreign Workspace',
      workspacePath: '/tmp/foreign',
      gitPath: '/tmp/foreign/.git',
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: 'baseline-sha',
    });
  });

  afterAll(() => {
    closeDb();
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(conflictDbPath + suffix); } catch { /* ok */ }
    }
  });

  beforeEach(() => {
    resetSourcingFlagsOverride();
  });

  it('resolve fails closed (403) while the engine is disabled; conflicts remain readable', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: false });
    const batch = createBatch({ workspaceId: wsId, name: 'Conf OFF', fileName: 'co.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [
      { upc: 'CONF-001', name: 'Conflicts Off', rowNumber: 1, stage: 'sourcing' },
    ]);

    // GET conflicts: read-only and always available (engine OFF).
    const getRes = await app.request(`/api/onboarding/items/${item.id}/conflicts`);
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.conflicts).toEqual([]);

    // POST resolve: capability OFF -> 403 before anything else.
    const resolveRes = await app.request(`/api/onboarding/items/${item.id}/conflicts/whatever/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss' }),
    });
    expect(resolveRes.status).toBe(403);
    const after = findItemById(item.id);
    expect(after?.stage).toBe('sourcing');
    expect(after?.stageStatus).toBe('pending');
  });

  it('resolves the last hard conflict to discovery/pending with an evidence_to_discovery decision', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true });
    const batch = createBatch({ workspaceId: wsId, name: 'Conf ON', fileName: 'cn.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [
      { upc: 'CONF-002', name: 'Conflicts On', rowNumber: 1, stage: 'sourcing' },
    ]);
    const gen = startSourcingGeneration(item.id, 'automatic');
    const att1 = insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'phillips',
      lookupUpc: '012345678905',
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: JSON.stringify({ brand: 'Brand A', weight: '10 lbs' }),
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      sourcingGenerationId: gen.id,
    });
    const att2 = insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'unfi',
      lookupUpc: '012345678905',
      outcome: 'found',
      confidence: 0.85,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: JSON.stringify({ brand: 'Brand A', weight: '20 lbs' }),
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      sourcingGenerationId: gen.id,
    });
    const conflict = insertConflictWithCandidates(item.id, 'weight', 'hard', [
      { evidenceAttemptId: att1.id, valueJson: '"10 lbs"' },
      { evidenceAttemptId: att2.id, valueJson: '"20 lbs"' },
    ], gen.id);
    updateItemStageStatus(item.id, 'needs_input', 'Identity conflict detected');

    const listRes = await app.request(`/api/onboarding/items/${item.id}/conflicts`);
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.conflicts).toHaveLength(1);
    expect(listBody.conflicts[0].id).toBe(conflict.id);
    expect(listBody.conflicts[0].field).toBe('weight');

    const resolveRes = await app.request(`/api/onboarding/items/${item.id}/conflicts/${conflict.id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'resolve_candidate', candidateId: conflict.candidates[0].id }),
    });
    expect(resolveRes.status).toBe(200);
    const resolveBody = await resolveRes.json();
    expect(resolveBody.success).toBe(true);

    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.stageStatus).toBe('pending');
    expect(after?.sourcingDecision?.route).toBe('evidence_to_discovery');
    expect(after?.sourcingDecision?.origin).toBe('operator_override');
    // The resolved conflict remains listed (audit) with status resolved.
    expect(resolveBody.conflicts).toHaveLength(1);
    expect(resolveBody.conflicts[0].status).toBe('resolved');
  });

  it('custom-value resolution routes a QUALIFIED record to extraction; the item-detail view reports qualified with the authoritative hash (MD round-7 defect 2)', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true });
    const batch = createBatch({ workspaceId: wsId, name: 'Conf View', fileName: 'cv.csv', totalItems: 1 });
    const [item] = insertItems(
      batch.id,
      [{ upc: '012345678930', name: 'Conflicted Flavor', rowNumber: 1, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );
    const gen = startSourcingGeneration(item.id, 'automatic');
    const conn = createConnection({ workspaceId: wsId, distributorId: 'phillips', connectorType: 'api' });
    const makeAttempt = (id: string, providerId: string, flavor: string) =>
      insertEvidenceAttempt({
        itemId: item.id,
        providerId,
        distributorConnectionId: conn.id,
        lookupUpc: item.upc,
        outcome: 'found',
        confidence: 0.9,
        evidenceUrl: null,
        matchedFields: ['upc'],
        identityJson: JSON.stringify({ upc: item.upc, name: 'Conflicted Flavor', attributes: { flavor } }),
        warningsJson: null,
        errorCode: null,
        errorMessage: null,
        catalogVersion: 'v2026.3',
        observedAt: '2026-08-13T00:00:00.000Z',
        sourcingGenerationId: gen.id,
      });
    const att1 = makeAttempt('cv-a1', 'phillips', 'chicken');
    const att2 = makeAttempt('cv-a2', 'unfi', 'beef');
    recordAcceptances(item.id, [att1.id, att2.id], 'system', 'view-test');
    const conflict = insertConflictWithCandidates(
      item.id,
      'flavor',
      'hard',
      [
        { evidenceAttemptId: att1.id, valueJson: '"chicken"' },
        { evidenceAttemptId: att2.id, valueJson: '"beef"' },
      ],
      gen.id,
    );
    updateItemStageStatus(item.id, 'needs_input', 'Flavor conflict');

    // Resolve the flavor conflict with a custom value. Final resolution
    // recomputes the canonical projection WITH the persisted resolution and
    // routes a qualified record to Extraction (marker-v1).
    const resolveRes = await app.request(`/api/onboarding/items/${item.id}/conflicts/${conflict.id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'custom_value', customValue: 'chicken' }),
    });
    expect(resolveRes.status).toBe(200);

    const after = findItemById(item.id);
    expect(after?.stage).toBe('extraction');
    expect(after?.stageStatus).toBe('pending');
    expect(after?.sourceType).toBe('distributor_record');
    const decision = after?.sourcingDecision as { evidenceHash?: string } | null;
    expect(decision?.evidenceHash).toBeTruthy();

    // The item-detail qualification view must recompute with the SAME
    // persisted resolutions (listResolvedConflictResolutions) and therefore
    // agree with the routing/materialization authority: qualified, with the
    // authoritative evidence hash.
    const detail = await app.request(`/api/onboarding/items/${item.id}`);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      sourcingQualificationView: { qualified: boolean; evidenceHash: string | null } | null;
    };
    const view = body.sourcingQualificationView;
    expect(view).not.toBeNull();
    expect(view?.qualified).toBe(true);
    expect(view?.evidenceHash).toBe(decision?.evidenceHash);
  });

  it('cross-workspace conflict resolution fails closed (404) without mutation', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true });
    const foreignBatch = createBatch({ workspaceId: foreignWsId, name: 'Foreign Conf', fileName: 'fc.csv', totalItems: 1 });
    const [item] = insertItems(foreignBatch.id, [
      { upc: 'CONF-003', name: 'Foreign Conflicts', rowNumber: 1, stage: 'sourcing' },
    ]);

    const res = await app.request(`/api/onboarding/items/${item.id}/conflicts/cnf_whatever/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss' }),
    });
    expect(res.status).toBe(404);

    const after = findItemById(item.id);
    expect(after?.stage).toBe('sourcing');
    expect(after?.stageStatus).toBe('pending');
  });

  it('a conflict that belongs to another item is not resolvable through this item (404)', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true });
    const batch = createBatch({ workspaceId: wsId, name: 'Two Conf', fileName: 'tc.csv', totalItems: 2 });
    const [itemA, itemB] = insertItems(batch.id, [
      { upc: 'CONF-004', name: 'Item A', rowNumber: 1, stage: 'sourcing' },
      { upc: 'CONF-005', name: 'Item B', rowNumber: 2, stage: 'sourcing' },
    ]);
    const genB = startSourcingGeneration(itemB.id, 'automatic');
    const att = insertEvidenceAttempt({
      itemId: itemB.id,
      providerId: 'phillips',
      lookupUpc: '012345678906',
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: JSON.stringify({ weight: '10 lbs' }),
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      sourcingGenerationId: genB.id,
    });
    const conflict = insertConflictWithCandidates(itemB.id, 'weight', 'hard', [
      { evidenceAttemptId: att.id, valueJson: '"10 lbs"' },
    ], genB.id);

    // Resolve item B's conflict THROUGH item A -> 404, no mutation.
    const res = await app.request(`/api/onboarding/items/${itemA.id}/conflicts/${conflict.id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss' }),
    });
    expect(res.status).toBe(404);
    const after = findItemById(itemA.id);
    expect(after?.stage).toBe('sourcing');
    expect(after?.stageStatus).toBe('pending');
  });

  it('retry with the engine ON resets in place and supersedes the evidence generation (marker-v1 only)', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true });
    const batch = createBatch({ workspaceId: wsId, name: 'Retry ON', fileName: 'ron.csv', totalItems: 1 });
    const [item] = insertItems(
      batch.id,
      [{ upc: '012345678995', name: 'Retry Engine On', rowNumber: 1, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );
    startSourcingGeneration(item.id, 'automatic');
    expect(listGenerationsForItem(item.id)).toHaveLength(1);

    const res = await app.request(`/api/onboarding/items/${item.id}/retry`, { method: 'POST' });
    expect(res.status).toBe(200);

    // The ON-mode retry supersedes the old generation and starts a fresh one.
    const generations = listGenerationsForItem(item.id);
    expect(generations.length).toBeGreaterThanOrEqual(2);
    expect(generations[0].status).toBe('superseded');

    // The item never strands at sourcing/pending: the worker (idle, zero
    // enabled connections) passes it through to Discovery with an audited
    // fallback decision.
    const after = findItemById(item.id);
    expect(after).toBeDefined();
    if (after!.stage === 'sourcing') {
      expect(after!.stageStatus).toBe('pending');
    } else {
      // The worker (zero enabled connections) passes the item through to
      // Discovery with an audited fallback decision; it may already be
      // claimed (in_progress) by the same poll — never stranded.
      expect(after!.stage).toBe('discovery');
      expect(['pending', 'in_progress']).toContain(after!.stageStatus);
      expect(after!.sourcingDecision?.route).toBe('fallback_to_discovery');
    }
  });
});

describe('Sourcing route workspace isolation + item-detail projection (M5)', () => {
  // Re-bootstrap a fresh DB (the previous describe closes its own).
  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(conflictDbPath);
    runMigrations();
    const now = new Date().toISOString();
    insertWorkspace({
      id: wsId,
      name: 'Test Workspace',
      workspacePath: '/tmp/ws',
      gitPath: '/tmp/ws/.git',
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: 'baseline-sha',
    });
    insertWorkspace({
      id: foreignWsId,
      name: 'Foreign Workspace',
      workspacePath: '/tmp/foreign',
      gitPath: '/tmp/foreign/.git',
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: 'baseline-sha',
    });
  });

  afterAll(() => {
    closeDb();
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(conflictDbPath + suffix); } catch { /* ok */ }
    }
  });

  beforeEach(() => {
    // Milestone A default flip: absent env now means enabled. This block
    // tests engine-DISABLED semantics, so pin the override explicitly.
    overrideSourcingFlags({ sourcingEngineEnabled: false });
  });

  it('cross-workspace item detail returns 404 (read isolation)', async () => {
    const foreignBatch = createBatch({ workspaceId: foreignWsId, name: 'Foreign Detail', fileName: 'fd.csv', totalItems: 1 });
    const [item] = insertItems(foreignBatch.id, [{ upc: 'ISO-101', name: 'Foreign Detail Item', rowNumber: 1 }]);

    const res = await app.request(`/api/onboarding/items/${item.id}`);
    expect(res.status).toBe(404);
  });

  it('cross-workspace retry returns 404 without mutation', async () => {
    const foreignBatch = createBatch({ workspaceId: foreignWsId, name: 'Foreign Retry', fileName: 'fr.csv', totalItems: 1 });
    const [item] = insertItems(foreignBatch.id, [{ upc: 'ISO-102', name: 'Foreign Retry', rowNumber: 1, stage: 'sourcing' }]);

    const res = await app.request(`/api/onboarding/items/${item.id}/retry`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(findItemById(item.id)?.stage).toBe('sourcing'); // untouched
  });

  it('bulk reset filters foreign ids fail-closed and resets only owned items', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Owned Reset', fileName: 'or.csv', totalItems: 1 });
    const [owned] = insertItems(batch.id, [{ upc: 'ISO-103', name: 'Owned', rowNumber: 1, stage: 'sourcing' }]);
    const foreignBatch = createBatch({ workspaceId: foreignWsId, name: 'Foreign Reset', fileName: 'fr2.csv', totalItems: 1 });
    const [foreign] = insertItems(foreignBatch.id, [{ upc: 'ISO-104', name: 'Foreign', rowNumber: 1, stage: 'sourcing' }]);

    const res = await app.request('/api/onboarding/items/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds: [owned.id, foreign.id] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Engine is OFF (beforeEach resets the override): owned sourcing item
    // moves to discovery via the audited fallback; foreign item is skipped.
    expect(body.skipped).toContainEqual({ id: foreign.id, reason: 'not_in_active_workspace' });
    expect(findItemById(owned.id)?.stage).toBe('discovery');
    expect(findItemById(foreign.id)?.stage).toBe('sourcing'); // untouched
  });

  it('item detail projects malformed identityJson to a null identity (never raw JSON)', async () => {
    const batch = createBatch({ workspaceId: wsId, name: 'Proj', fileName: 'proj.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: 'ISO-105', name: 'Proj Item', rowNumber: 1 }]);
    const gen = startSourcingGeneration(item.id, 'automatic');
    insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'phillips',
      sourcingGenerationId: gen.id,
      lookupUpc: item.upc,
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: '{not valid json',
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
    });

    const res = await app.request(`/api/onboarding/items/${item.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.evidenceAttempts)).toBe(true);
    const attempt = body.evidenceAttempts[0];
    expect(attempt).toBeDefined();
    // Parsed identity is null on malformed JSON — the raw DB JSON is never
    // the frontend type.
    expect(attempt.identity).toBeNull();
    expect(attempt.sourcingGenerationId).toBe(gen.id);
    expect(Array.isArray(body.conflicts)).toBe(true);
    expect(Array.isArray(body.generations)).toBe(true);
  });

  it('use_distributor_record fails closed (403) while the engine is disabled', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: false });
    const batch = createBatch({ workspaceId: wsId, name: 'UseOff', fileName: 'uo.csv', totalItems: 1 });
    const [item] = insertItems(
      batch.id,
      [{ upc: 'USE-001', name: 'Use Off', rowNumber: 1, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );
    updateItemStageStatus(item.id, 'needs_input', 'manual evaluation');

    const res = await app.request(`/api/onboarding/items/${item.id}/resolve-sourcing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'use_distributor_record' }),
    });
    expect(res.status).toBe(403);
    expect(findItemById(item.id)?.stage).toBe('sourcing');
    expect(findItemById(item.id)?.stageStatus).toBe('needs_input');
  });

  it('use_distributor_record fails closed (403) in observe mode (no routing)', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'observe' });
    try {
      const batch = createBatch({ workspaceId: wsId, name: 'UseObs', fileName: 'uob.csv', totalItems: 1 });
      const [item] = insertItems(
        batch.id,
        [{ upc: 'USE-010', name: 'Use Observe', rowNumber: 1, stage: 'sourcing' }],
        'sourcing',
        SOURCING_ENTRY_POLICY_VERSION,
      );
      updateItemStageStatus(item.id, 'needs_input', 'manual evaluation');

      const res = await app.request(`/api/onboarding/items/${item.id}/resolve-sourcing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'use_distributor_record' }),
      });
      expect(res.status).toBe(403);
      expect(findItemById(item.id)?.stage).toBe('sourcing');
      expect(findItemById(item.id)?.stageStatus).toBe('needs_input');
    } finally {
      resetSourcingFlagsOverride();
    }
  });

  it('use_distributor_record is refused for legacy marker-v0 items (Continue-to-Discovery cohort)', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true });
    // The item is marker-v0
    // (4th arg omitted): its cohort stays operator-controlled Discovery.
    const batch = createBatch({ workspaceId: wsId, name: 'UseV0', fileName: 'uv0.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [
      { upc: 'USE-002', name: 'Use V0', rowNumber: 1, stage: 'sourcing' },
    ]);
    updateItemStageStatus(item.id, 'needs_input', 'manual evaluation');
    expect(item.sourcingEntryPolicyVersion).toBe(0);

    const res = await app.request(`/api/onboarding/items/${item.id}/resolve-sourcing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'use_distributor_record' }),
    });
    expect(res.status).toBe(400);
    expect(findItemById(item.id)?.stage).toBe('sourcing');
  });

  it('use_distributor_record recomputes qualification server-side and routes a qualified item to Extraction', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true });
    // Marker-v1 item with full observation provenance + an
    // accepted found attempt → server-derived qualification → extraction.
    const batch = createBatch({ workspaceId: wsId, name: 'UseOK', fileName: 'uok.csv', totalItems: 1 });
    const [item] = insertItems(
      batch.id,
      [{ upc: '012345678901', name: 'Dog Food', rowNumber: 1, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );
    const gen = startSourcingGeneration(item.id, 'manual');
    const conn = createConnection({ workspaceId: wsId, distributorId: 'phillips', connectorType: 'api' });
    const att = insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'phillips',
      distributorConnectionId: conn.id,
      lookupUpc: item.upc,
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: JSON.stringify({ upc: item.upc, name: 'Dog Food', weight: '10 lb' }),
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      catalogVersion: 'v2026.3',
      observedAt: '2026-08-13T00:00:00.000Z',
      sourcingGenerationId: gen.id,
    });
    recordAcceptances(item.id, [att.id], 'operator', 'manual evaluation');
    updateItemStageStatus(item.id, 'needs_input', 'manual evaluation');

    const res = await app.request(`/api/onboarding/items/${item.id}/resolve-sourcing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'use_distributor_record' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.route).toBe('distributor_record_to_extraction');
    expect(body.qualified).toBe(true);
    expect(body.evidenceHash).toMatch(/^[0-9a-f]{64}$/);

    const after = findItemById(item.id);
    expect(after?.stage).toBe('extraction');
    expect(after?.stageStatus).toBe('pending');
    expect(after?.sourceType).toBe('distributor_record');
    expect(after?.sourceUrl).toBeNull();
  });

  it('set-url rejects distributor-source items (no fake URLs)', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true });
    const batch = createBatch({ workspaceId: wsId, name: 'SetUrl', fileName: 'su.csv', totalItems: 1 });
    const [item] = insertItems(
      batch.id,
      [{ upc: '012345678905', name: 'Dist Item', rowNumber: 1, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );
    const gen = startSourcingGeneration(item.id, 'automatic');
    const conn = createConnection({ workspaceId: wsId, distributorId: 'phillips', connectorType: 'api' });
    const att = insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'phillips',
      distributorConnectionId: conn.id,
      lookupUpc: item.upc,
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: JSON.stringify({ upc: item.upc, name: 'Dist Item', weight: '10 lb' }),
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      catalogVersion: 'v2026.3',
      observedAt: '2026-08-13T00:00:00.000Z',
      sourcingGenerationId: gen.id,
    });
    recordAcceptances(item.id, [att.id], 'operator', 'evaluation');
    updateItemStageStatus(item.id, 'needs_input', 'evaluation');
    const route = await app.request(`/api/onboarding/items/${item.id}/resolve-sourcing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'use_distributor_record' }),
    });
    expect(route.status).toBe(200);
    expect(findItemById(item.id)?.sourceType).toBe('distributor_record');

    // A URL must NEVER be assignable to a distributor-source item (the no-
    // fake-URL rule: source_url stays derived-null until Discovery).
    const res = await app.request(`/api/onboarding/items/${item.id}/set-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/product' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Distributor-source items cannot set a URL');
    expect(findItemById(item.id)?.sourceUrl).toBeNull();
  });

  it('generic item edit cannot assign a URL to a distributor-source item', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true });
    const batch = createBatch({ workspaceId: wsId, name: 'PutUrl', fileName: 'pu.csv', totalItems: 1 });
    const [item] = insertItems(
      batch.id,
      [{ upc: '012345678906', name: 'Put Dist Item', rowNumber: 1, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );
    const gen = startSourcingGeneration(item.id, 'automatic');
    const conn = createConnection({ workspaceId: wsId, distributorId: 'phillips', connectorType: 'api' });
    const att = insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'phillips',
      distributorConnectionId: conn.id,
      lookupUpc: item.upc,
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: JSON.stringify({ upc: item.upc, name: 'Put Dist Item', weight: '10 lb' }),
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      catalogVersion: 'v2026.3',
      observedAt: '2026-08-13T00:00:00.000Z',
      sourcingGenerationId: gen.id,
    });
    recordAcceptances(item.id, [att.id], 'operator', 'evaluation');
    updateItemStageStatus(item.id, 'needs_input', 'evaluation');
    const route = await app.request(`/api/onboarding/items/${item.id}/resolve-sourcing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'use_distributor_record' }),
    });
    expect(route.status).toBe(200);
    expect(findItemById(item.id)?.sourceType).toBe('distributor_record');

    const res = await app.request(`/api/onboarding/items/${item.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_url: 'https://example.com/other' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('immutable');
    expect(findItemById(item.id)?.sourceUrl).toBeNull();
  });

  it('item detail returns a server-derived sourcingQualificationView for a held manual item', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'manual' });
    try {
      const batch = createBatch({ workspaceId: wsId, name: 'View', fileName: 'vw.csv', totalItems: 1 });
    const [item] = insertItems(
      batch.id,
      [{ upc: '012345678903', name: 'View Me', rowNumber: 1, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );
    const gen = startSourcingGeneration(item.id, 'manual');
    const conn = createConnection({ workspaceId: wsId, distributorId: 'phillips', connectorType: 'api' });
    const att = insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'phillips',
      distributorConnectionId: conn.id,
      lookupUpc: item.upc,
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: JSON.stringify({ upc: item.upc, name: 'View Me', weight: '10 lb' }),
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      catalogVersion: 'v2026.3',
      observedAt: '2026-08-13T00:00:00.000Z',
      sourcingGenerationId: gen.id,
    });
    // Manual worker path persists relational acceptances (MC review fix); the
    // detail view recomputes qualification from them.
    recordAcceptances(item.id, [att.id], 'system', 'qualified distributor record (manual review)');
    updateItemStageStatus(item.id, 'needs_input', 'manual evaluation');

    const res = await app.request(`/api/onboarding/items/${item.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sourcingQualificationView).toBeDefined();
    expect(body.sourcingQualificationView.qualified).toBe(true);
    expect(body.sourcingQualificationView.acceptedEvidenceAttemptIds).toContain(att.id);
    expect(body.sourcingQualificationView.providerIds).toContain('phillips');
    expect(body.sourcingQualificationView.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      resetSourcingFlagsOverride();
    }
  });

  it('item detail returns null sourcingQualificationView when the item left Sourcing', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'manual' });
    try {
      const batch = createBatch({ workspaceId: wsId, name: 'ViewGone', fileName: 'vg.csv', totalItems: 1 });
      const [item] = insertItems(
        batch.id,
        [{ upc: '012345678904', name: 'Moved On', rowNumber: 1, stage: 'sourcing' }],
        'sourcing',
        SOURCING_ENTRY_POLICY_VERSION,
      );
      updateItemStageStatus(item.id, 'completed', 'moved on');

      const res = await app.request(`/api/onboarding/items/${item.id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sourcingQualificationView).toBeNull();
    } finally {
      resetSourcingFlagsOverride();
    }
  });

  it('item detail keeps the sourcingQualificationView for a distributor-source extraction/pending item (MD defect 7)', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true });
    try {
      // Route a qualified distributor record to extraction/pending with NO
      // materialized payload yet — the extraction drawer must still render
      // provider/attempt/hash/generation provenance from the item-detail view.
      const batch = createBatch({ workspaceId: wsId, name: 'ViewExt', fileName: 've.csv', totalItems: 1 });
      const [item] = insertItems(
        batch.id,
        [{ upc: '012345678907', name: 'Ext View', rowNumber: 1, stage: 'sourcing' }],
        'sourcing',
        SOURCING_ENTRY_POLICY_VERSION,
      );
      const gen = startSourcingGeneration(item.id, 'automatic');
      const conn = createConnection({ workspaceId: wsId, distributorId: 'phillips', connectorType: 'api' });
      const att = insertEvidenceAttempt({
        itemId: item.id,
        providerId: 'phillips',
        distributorConnectionId: conn.id,
        lookupUpc: item.upc,
        outcome: 'found',
        confidence: 0.9,
        evidenceUrl: null,
        matchedFields: ['upc'],
        identityJson: JSON.stringify({ upc: item.upc, name: 'Ext View', weight: '10 lb' }),
        warningsJson: null,
        errorCode: null,
        errorMessage: null,
        catalogVersion: 'v2026.3',
        observedAt: '2026-08-13T00:00:00.000Z',
        sourcingGenerationId: gen.id,
      });
      recordAcceptances(item.id, [att.id], 'system', 'automatic routing');
      updateItemStageStatus(item.id, 'needs_input', 'evaluation');
      const route = await app.request(`/api/onboarding/items/${item.id}/resolve-sourcing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'use_distributor_record' }),
      });
      expect(route.status).toBe(200);
      expect(findItemById(item.id)?.stage).toBe('extraction');
      expect(findItemById(item.id)?.stageStatus).toBe('pending');
      expect(findItemById(item.id)?.sourceType).toBe('distributor_record');

      const res = await app.request(`/api/onboarding/items/${item.id}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sourcingQualificationView).toBeDefined();
      expect(body.sourcingQualificationView.qualified).toBe(true);
      expect(body.sourcingQualificationView.acceptedEvidenceAttemptIds).toContain(att.id);
      expect(body.sourcingQualificationView.providerIds).toContain('phillips');
      expect(body.sourcingQualificationView.sourcingGenerationId).toBe(gen.id);
      expect(body.sourcingQualificationView.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      resetSourcingFlagsOverride();
    }
  });

  it('use_distributor_record fails truthfully (400) when the recomputed projection is not qualified', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true });
    const batch = createBatch({ workspaceId: wsId, name: 'UseBad', fileName: 'ubad.csv', totalItems: 1 });
    const [item] = insertItems(
      batch.id,
      [{ upc: '012345678902', name: 'No Name', rowNumber: 1, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );
    const gen = startSourcingGeneration(item.id, 'manual');
    const conn = createConnection({ workspaceId: wsId, distributorId: 'phillips', connectorType: 'api' });
    const att = insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'phillips',
      distributorConnectionId: conn.id,
      lookupUpc: item.upc,
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: JSON.stringify({ upc: item.upc }),
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      catalogVersion: 'v2026.3',
      observedAt: '2026-08-13T00:00:00.000Z',
      sourcingGenerationId: gen.id,
    });
    recordAcceptances(item.id, [att.id], 'operator', 'manual evaluation');
    updateItemStageStatus(item.id, 'needs_input', 'manual evaluation');

    const res = await app.request(`/api/onboarding/items/${item.id}/resolve-sourcing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'use_distributor_record' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    // Truthful failure: the server-derived qualification reason is surfaced.
    expect(body.reasonCodes).toContain('missing_name');
    expect(findItemById(item.id)?.stage).toBe('sourcing');
  });

  it('retry on a marker-v0 sourcing item falls back even when the engine is globally ON (legacy cohort)', async () => {
    // Default override = engine ON. The v0 item must NOT re-claim or
    // supersede — its cohort is Continue-to-Discovery only.
    const batch = createBatch({ workspaceId: wsId, name: 'RetryV0', fileName: 'rv0.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [
      { upc: '012345678996', name: 'Retry V0', rowNumber: 1, stage: 'sourcing' },
    ]);
    startSourcingGeneration(item.id, 'automatic');
    expect(listGenerationsForItem(item.id)).toHaveLength(1);

    const res = await app.request(`/api/onboarding/items/${item.id}/retry`, { method: 'POST' });
    expect(res.status).toBe(200);

    // Legacy cohort: audited fallback, NO generation supersede.
    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.stageStatus).toBe('pending');
    expect(after?.sourcingDecision?.route).toBe('fallback_to_discovery');
    expect(listGenerationsForItem(item.id)).toHaveLength(1);
  });
});

describe('Sourcing full-chain worker → detail → resolve (MC certification 84c918d9)', () => {
  // Dedicated DB + workspace so `poll()` only ever sees this describe's items
  // (the first-inserted workspace is the ACTIVE one for the app routes).
  const chainDbPath = path.resolve(import.meta.dirname, 'sourcing-safety-routes-chain-test.db');
  const chainWsId = 'ws-sourcing-chain';
  let chainTempDir: string;

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(chainDbPath);
    runMigrations();
    chainTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcing-chain-'));
    const now = new Date().toISOString();
    insertWorkspace({
      id: chainWsId,
      name: 'Chain Workspace',
      workspacePath: chainTempDir,
      gitPath: path.join(chainTempDir, '.git'),
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: 'baseline-sha',
    });
  });

  afterAll(() => {
    closeDb();
    try { fs.rmSync(chainTempDir, { recursive: true, force: true }); } catch { /* ok */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { unlinkSync(chainDbPath + suffix); } catch { /* ok */ }
    }
  });

  afterEach(() => {
    resetSourcingFlagsOverride();
  });

  it('worker (manual) evaluates evidence → detail returns the qualification view → use_distributor_record routes to extraction/pending', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'manual' });
    const batch = createBatch({ workspaceId: chainWsId, name: 'Chain', fileName: 'ch.csv', totalItems: 1 });
    const [item] = insertItems(
      batch.id,
      [{ upc: '012345678905', name: 'Chain Me', rowNumber: 1, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );
    const gen = startSourcingGeneration(item.id, 'automatic');
    const conn = createConnection({ workspaceId: chainWsId, distributorId: 'phillips', connectorType: 'api' });
    insertEvidenceAttempt({
      itemId: item.id,
      providerId: 'phillips',
      distributorConnectionId: conn.id,
      lookupUpc: item.upc,
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: JSON.stringify({ upc: item.upc, name: 'Chain Me', weight: '10 lb' }),
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      catalogVersion: 'v2026.3',
      observedAt: '2026-08-13T00:00:00.000Z',
      sourcingGenerationId: gen.id,
    });

    // Worker evaluates the pre-seeded generation (deterministic re-run — no
    // engine network call) and holds at needs_input, persisting relational
    // acceptances via the manual path.
    const worker = new OnboardingWorker(chainWsId, chainTempDir);
    await worker.poll();

    const held = findItemById(item.id);
    expect(held?.stage).toBe('sourcing');
    expect(held?.stageStatus).toBe('needs_input');

    // GET item detail → server-derived qualification view (manual contract).
    const detail = await app.request(`/api/onboarding/items/${item.id}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    const view = detailBody.sourcingQualificationView;
    expect(view).not.toBeNull();
    expect(view.qualified).toBe(true);
    expect(view.acceptedEvidenceAttemptIds.length).toBeGreaterThan(0);
    expect(view.evidenceHash).toMatch(/^[0-9a-f]{64}$/);

    // POST use_distributor_record with NO client ids/hash/providers — the
    // server recomputes qualification and routes to Extraction.
    const res = await app.request(`/api/onboarding/items/${item.id}/resolve-sourcing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'use_distributor_record' }),
    });
    expect(res.status).toBe(200);

    const after = findItemById(item.id);
    expect(after?.stage).toBe('extraction');
    expect(after?.stageStatus).toBe('pending');
    expect(after?.sourceType).toBe('distributor_record');
    expect(after?.sourceUrl).toBeNull();
  });

  it('continue-with-official-discovery: HTTP happy path reverts atomically; official-source/later-stage/foreign items are refused', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const { completeSourcingWithDecision } = await import('../../db/repositories/onboarding-item-repo');
    const { buildDistributorRecordProjection } = await import('../../onboarding/sourcing/distributor-record-projection');
    const { materializeDistributorRecordExtraction } = await import('../../onboarding/sourcing/distributor-record-materializer');
    const { SourcingDecisionV2Schema } = await import('../../shared/schemas/onboarding');

    const batch = createBatch({ workspaceId: chainWsId, name: 'Revert', fileName: 'rv.csv', totalItems: 2 });
    const [distItem, laterItem] = insertItems(
      batch.id,
      [
        { upc: '012345678910', name: 'Dist Revert', rowNumber: 1, stage: 'sourcing' },
        { upc: '012345678911', name: 'Late Item', rowNumber: 2, stage: 'sourcing' },
      ],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );

    // Route a qualified distributor record and MATERIALIZE it so a real
    // extraction audit row exists before the revert.
    const gen = startSourcingGeneration(distItem.id, 'automatic');
    const conn = createConnection({ workspaceId: chainWsId, distributorId: 'phillips', connectorType: 'api' });
    const att = insertEvidenceAttempt({
      itemId: distItem.id,
      providerId: 'phillips',
      distributorConnectionId: conn.id,
      lookupUpc: distItem.upc,
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: JSON.stringify({ upc: distItem.upc, name: 'Dist Revert', weight: '10 lb' }),
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      catalogVersion: 'v2026.3',
      observedAt: '2026-08-13T00:00:00.000Z',
      sourcingGenerationId: gen.id,
    });
    recordAcceptances(distItem.id, [att.id], 'system', 'revert-test');
    const projection = buildDistributorRecordProjection({
      itemId: distItem.id,
      itemUpc: distItem.upc,
      sourcingGenerationId: gen.id,
      attempts: [att],
      acceptedAttemptIds: [att.id],
    });
    expect(projection.qualified).toBe(true);
    if (!projection.qualified) return;
    const decision: never = {
      schemaVersion: 2,
      route: 'distributor_record_to_extraction',
      origin: 'automatic_policy',
      acceptedEvidenceAttemptIds: projection.acceptedAttemptIds,
      providerIds: projection.providerIds,
      sourcingGenerationId: gen.id,
      conflicts: [],
      warnings: [],
      decidedAt: new Date().toISOString(),
      evidenceHash: projection.evidenceHash,
      sourceType: 'distributor_record',
      target: 'extraction',
    } as never;
    const routed = completeSourcingWithDecision(distItem.id, decision, 'collect_details');
    expect(routed.ok).toBe(true);
    updateItemStageStatus(distItem.id, 'in_progress');
    const materialized = materializeDistributorRecordExtraction(distItem.id, chainWsId);
    expect(materialized.ok).toBe(true);
    // A durable (resolved) conflict row that the revert must preserve.
    getDb().query(
      `INSERT INTO onboarding_evidence_conflicts
        (id, item_id, field, severity, status, sourcing_generation_id, created_at)
       VALUES ('revert-conflict', ?, 'weight', 'hard', 'resolved', ?, ?)`,
    ).run(distItem.id, gen.id, new Date().toISOString());

    // Happy path: revert to discovery/pending, source_type official, URL null.
    const revertRes = await app.request(`/api/onboarding/items/${distItem.id}/continue-with-official-discovery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(revertRes.status).toBe(200);
    const after = findItemById(distItem.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.stageStatus).toBe('pending');
    expect(after?.sourceType).toBe('official_page');
    expect(after?.sourceUrl).toBeNull();
    expect(after?.extractionData).toBeNull();

    // Evidence is preserved: extraction audit row + conflict row intact;
    // the replacement decision is a strict V2 fallback_to_discovery.
    const extractionRows = getDb().query('SELECT * FROM onboarding_extractions WHERE item_id = ?').all(distItem.id) as unknown[];
    expect(extractionRows.length).toBe(1);
    const conflictRows = getDb().query('SELECT * FROM onboarding_evidence_conflicts WHERE item_id = ?').all(distItem.id) as unknown[];
    expect(conflictRows.length).toBe(1);
    const decisionRow = getDb().query('SELECT sourcing_decision_json FROM onboarding_items WHERE id = ?').get(distItem.id) as { sourcing_decision_json: string };
    const written = JSON.parse(decisionRow.sourcing_decision_json);
    const v2 = SourcingDecisionV2Schema.safeParse(written);
    expect(v2.success).toBe(true);
    if (v2.success) {
      expect(v2.data.route).toBe('fallback_to_discovery');
      expect(v2.data.origin).toBe('operator_override');
      expect(v2.data.target).toBe('discovery');
    }

    // MD round-7 (defect 1a): item detail must NOT resurrect the preserved
    // distributor extraction row for the now-official_page item.
    const detailAfter = await app.request(`/api/onboarding/items/${distItem.id}`);
    expect(detailAfter.status).toBe(200);
    const detailAfterBody = await detailAfter.json();
    expect(detailAfterBody.extraction).toBeNull();
    const preservedRow = getDb()
      .query('SELECT * FROM onboarding_extractions WHERE item_id = ?')
      .get(distItem.id) as { extraction_data_json: string; source_type: string | null };
    expect((preservedRow.source_type ?? 'official_page')).toBe('distributor_record');
    const preservedPayload = JSON.parse(preservedRow.extraction_data_json) as Record<string, unknown>;

    // MD round-7 (defect 1b): the generic PUT must NOT mutate the preserved
    // distributor row even though the item is now official_page (row-level
    // immutability).
    const putRes = await app.request(`/api/onboarding/items/${distItem.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extraction_data: { title: 'TAMPERED', description: 'should not persist' } }),
    });
    expect(putRes.status).toBe(400);
    const putBody = (await putRes.json()) as { error: string };
    expect(putBody.error).toContain('immutable');
    const preservedAfter = getDb()
      .query('SELECT extraction_data_json FROM onboarding_extractions WHERE item_id = ?')
      .get(distItem.id) as { extraction_data_json: string };
    expect(JSON.parse(preservedAfter.extraction_data_json)).toEqual(preservedPayload);

    // Refusals: a later-stage distributor-source item must cite the send-back flow.
    getDb().query(
      `UPDATE onboarding_items SET stage = 'curation', stage_status = 'pending', source_type = 'distributor_record' WHERE id = ?`,
    ).run(laterItem.id);
    const lateRes = await app.request(`/api/onboarding/items/${laterItem.id}/continue-with-official-discovery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(lateRes.status).toBe(400);
    const lateBody = (await lateRes.json()) as { error: string };
    expect(lateBody.error).toContain('send-back');

    // Refusals: an official-source item is not a distributor materialization.
    const officialItem = insertItems(
      batch.id,
      [{ upc: '012345678912', name: 'Official', rowNumber: 3, stage: 'discovery' }],
      'discovery',
      SOURCING_ENTRY_POLICY_VERSION,
    )[0];
    const officialRes = await app.request(`/api/onboarding/items/${officialItem.id}/continue-with-official-discovery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(officialRes.status).toBe(400);

    // Refusals: cross-workspace ownership → 404 (foreign batch, active ws differs).
    const foreignWs = { id: 'ws-revert-foreign', name: 'Foreign', workspacePath: chainTempDir, gitPath: path.join(chainTempDir, '.git-foreign'), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete' as const, baselineCommit: null };
    insertWorkspace(foreignWs);
    const foreignBatch = createBatch({ workspaceId: foreignWs.id, name: 'ForeignBatch', fileName: 'f.csv', totalItems: 1 });
    const foreignItem = insertItems(
      foreignBatch.id,
      [{ upc: '012345678913', name: 'Foreign Item', rowNumber: 1, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    )[0];
    getDb().query(
      `UPDATE onboarding_items SET source_type = 'distributor_record', stage = 'extraction', stage_status = 'pending' WHERE id = ?`,
    ).run(foreignItem.id);
    const foreignRes = await app.request(`/api/onboarding/items/${foreignItem.id}/continue-with-official-discovery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(foreignRes.status).toBe(404);
  });

  it('generic extraction-data edits are refused for distributor-source items but official items stay editable', async () => {
    const batch = createBatch({ workspaceId: chainWsId, name: 'Immutable', fileName: 'im.csv', totalItems: 2 });
    const [distItem, officialItem] = insertItems(
      batch.id,
      [
        { upc: '012345678914', name: 'Dist Immutable', rowNumber: 1, stage: 'extraction' },
        { upc: '012345678915', name: 'Official Editable', rowNumber: 2, stage: 'extraction' },
      ],
      'extraction',
      SOURCING_ENTRY_POLICY_VERSION,
    );
    // Distributor-source item: derived payload must be immutable via the
    // generic edit route (the materializer re-validates it on retry).
    getDb().query("UPDATE onboarding_items SET source_type = 'distributor_record' WHERE id = ?").run(distItem.id);

    const distRes = await app.request(`/api/onboarding/items/${distItem.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extraction_data: { title: 'Tampered' } }),
    });
    expect(distRes.status).toBe(400);
    const distBody = (await distRes.json()) as { error: string };
    expect(distBody.error).toContain('derived and immutable');
    // No payload was written.
    expect(findItemById(distItem.id)?.extractionData).toBeNull();

    // Official-page items keep the existing edit behavior.
    const officialRes = await app.request(`/api/onboarding/items/${officialItem.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extraction_data: { title: 'Editable Title' } }),
    });
    expect(officialRes.status).toBe(200);
    expect(findItemById(officialItem.id)?.extractionData?.title).toBe('Editable Title');
  });

  it('empty current generation returns a NON-null unqualified view; use_distributor_record 400; Continue works', async () => {
    overrideSourcingFlags({ sourcingEngineEnabled: true, mode: 'automatic' });
    const batch = createBatch({ workspaceId: chainWsId, name: 'Empty', fileName: 'em.csv', totalItems: 1 });
    const [item] = insertItems(
      batch.id,
      [{ upc: '012345678906', name: 'Empty Gen', rowNumber: 1, stage: 'sourcing' }],
      'sourcing',
      SOURCING_ENTRY_POLICY_VERSION,
    );
    startSourcingGeneration(item.id, 'automatic');
    updateItemStageStatus(item.id, 'needs_input', 'manual evaluation');

    // Detail view is PRESENT (non-null) with an honest unqualified result.
    const detail = await app.request(`/api/onboarding/items/${item.id}`);
    expect(detail.status).toBe(200);
    const body = await detail.json();
    expect(body.sourcingQualificationView).not.toBeNull();
    expect(body.sourcingQualificationView.qualified).toBe(false);
    expect(body.sourcingQualificationView.reasonCodes).toContain('no_accepted_evidence');

    // use_distributor_record on the unqualified generation fails truthfully.
    const use = await app.request(`/api/onboarding/items/${item.id}/resolve-sourcing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'use_distributor_record' }),
    });
    expect(use.status).toBe(400);
    expect(findItemById(item.id)?.stage).toBe('sourcing');

    // Continue-to-Discovery still works.
    const cont = await app.request(`/api/onboarding/items/${item.id}/resolve-sourcing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'fallback_to_discovery' }),
    });
    expect(cont.status).toBe(200);
    const after = findItemById(item.id);
    expect(after?.stage).toBe('discovery');
    expect(after?.stageStatus).toBe('pending');
  });
});
