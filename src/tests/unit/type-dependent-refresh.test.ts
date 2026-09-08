import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createConfigSnapshot } from '../../db/repositories/classification-config-repo';
import { buildRuntimeSnapshot, persistRuntimeSnapshot } from '../../classification/runtime-snapshot';
import { enqueueRefreshItem, claimRefreshBatch } from '../../db/repositories/classification-refresh-repo';
import { processRefreshItem } from '../../classification/type-dependent-refresh';
import { overrideTypeFirstCurationFlags, resetTypeFirstCurationFlagsOverride } from '../../classification/flags';

describe('type-dependent-refresh (P1.4)', () => {
  const dbPath = `/tmp/test-refresh-${randomUUID()}.db`;
  const wsId = 'ws-refresh-test';

  beforeAll(() => {
    initDb(dbPath);
    runMigrations();
    overrideTypeFirstCurationFlags({
      typeDependentRecomputeEnabled: true,
      typeChangeRefreshWorkerEnabled: true,
      productTypeVerifierEnabled: false,
      productTypeShadowEnabled: false,
    });
  });

  afterAll(() => {
    resetTypeFirstCurationFlagsOverride();
    closeDb();
    try {
      unlinkSync(dbPath);
      unlinkSync(`${dbPath}-wal`);
      unlinkSync(`${dbPath}-shm`);
    } catch {
      // ok
    }
  });

  function loadConfigFixture(): any {
    const now = '2026-08-01T12:00:00.000Z';
    return {
      manifest: { schemaVersion: 1, compatibilityVersion: 1, createdAt: now, updatedAt: now, fileVersions: {} },
      productTypes: [
        { id: 'dog_food', name: 'Dog Food', description: null, attributeProfileId: 'dog-profile', oldIdAliases: [] },
        { id: 'cat_food', name: 'Cat Food', description: null, attributeProfileId: 'cat-profile', oldIdAliases: [] },
      ],
      attributes: [
        { id: 'brand', name: 'Brand', description: null, valueMode: 'freeText', canonicalUnit: null, allowedValues: [], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, isUniversal: true, group: 'Identity' },
        { id: 'dog_breed_size', name: 'Dog Breed Size', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Small', 'Large'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, isUniversal: false, group: 'Diet' },
        { id: 'hairball_control', name: 'Hairball Control', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Yes', 'No'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, isUniversal: false, group: 'Diet' },
      ],
      attributeProfiles: [
        { id: 'dog-profile', productTypeId: 'dog_food', name: 'Dog Profile', attributes: [{ attributeId: 'dog_breed_size', required: false, cardinality: 'single', applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] }] },
        { id: 'cat-profile', productTypeId: 'cat_food', name: 'Cat Profile', attributes: [{ attributeId: 'hairball_control', required: false, cardinality: 'single', applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] }] },
      ],
      attributeMappings: [
        { id: 'brand-map', attributeId: 'brand', catalogField: 'Brand', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
        { id: 'breed-map', attributeId: 'dog_breed_size', catalogField: 'BreedSize', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
        { id: 'hairball-map', attributeId: 'hairball_control', catalogField: 'Hairball', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      ],
      curationTargets: [
        { id: 'primary-product-type', kind: 'product_type', label: 'Primary Product Type', enabled: true, selectionMode: 'single', attributeId: null, catalogField: null, optionSource: 'configured', required: false, mandatory: false, sortOrder: 0 },
        { id: 'brand-target', kind: 'product_field', label: 'Brand', enabled: true, selectionMode: 'single', attributeId: 'brand', catalogField: 'Brand', optionSource: 'configured', required: false, mandatory: false, sortOrder: 1 },
        { id: 'breed-target', kind: 'product_field', label: 'Dog Breed Size', enabled: true, selectionMode: 'single', attributeId: 'dog_breed_size', catalogField: 'BreedSize', optionSource: 'configured', required: false, mandatory: false, sortOrder: 2 },
        { id: 'hairball-target', kind: 'product_field', label: 'Hairball Control', enabled: true, selectionMode: 'single', attributeId: 'hairball_control', catalogField: 'Hairball', optionSource: 'configured', required: false, mandatory: false, sortOrder: 3 },
      ],
      brands: [],
      guidance: [],
      modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only', textDataSharing: 'local_only' },
      dataSharing: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
    };
  }

  it('supersedes stale dependents under the reviewed product type without fabricating placeholder proposals', async () => {
    const db = getDb();
    const batchId = randomUUID();
    const itemId = randomUUID();
    const runId = randomUUID();
    const sku = 'SKU-RECOMP-1';

    insertWorkspace({
      id: wsId,
      name: 'Refresh WS',
      workspacePath: '/tmp/refresh',
      gitPath: '/tmp/refresh/.git',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });

    const config = loadConfigFixture();
    const { id: snapId, hash: snapHash } = createConfigSnapshot(wsId, config);
    const runtime = buildRuntimeSnapshot({
      workspaceId: wsId,
      workspacePath: '/tmp/refresh',
      productSku: sku,
      config,
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
      sourceProductHash: 'hash-sku-recomp',
    });
    persistRuntimeSnapshot(runtime);

    db.run(
      `INSERT INTO onboarding_batches (id, workspace_id, name, file_name, created_at, updated_at)
       VALUES (?, ?, 'Batch R', 'r.csv', datetime('now'), datetime('now'))`,
      [batchId, wsId],
    );
    db.run(
      `INSERT INTO onboarding_items (id, batch_id, row_number, upc, name, stage, stage_status, created_at, updated_at)
       VALUES (?, ?, 1, ?, 'Test Item', 'review', 'ready', datetime('now'), datetime('now'))`,
      [itemId, batchId, sku],
    );
    db.run(
      `INSERT INTO classification_runs (id, workspace_id, onboarding_item_id, product_sku, status, config_snapshot_hash, started_at, completed_at)
       VALUES (?, ?, ?, ?, 'completed', ?, datetime('now'), datetime('now'))`,
      [runId, wsId, itemId, sku, runtime.snapshotHash],
    );

    // Reviewed Primary Product Type: cat_food (accepted with human review)
    db.run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'primary_product_type', 'cat_food', '{"productTypeId":"cat_food"}', 0.9, 'accepted', datetime('now'))`,
      ['prop-type-cat', runId, sku],
    );
    db.run(
      `INSERT INTO classification_proposal_decisions
       (id, proposal_id, decision, decision_origin, created_at)
       VALUES (?, 'prop-type-cat', 'accepted', 'human_review', datetime('now'))`,
      [randomUUID()],
    );

    // Old dependent proposal from dog_food: dog_breed_size
    db.run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'field_assignment', 'dog_breed_size', '"Small"', 0.8, 'pending', datetime('now'))`,
      ['prop-breed-size', runId, sku],
    );
    db.run(
      `INSERT INTO classification_proposal_dependencies
       (workspace_id, proposal_id, dependency_kind, dependency_target_id, dependency_value_hash, created_at)
       VALUES (?, 'prop-breed-size', 'reviewed_product_type', 'dog_food', 'hash-dog', datetime('now'))`,
      [wsId],
    );

    // Enqueue refresh item
    const queueId = enqueueRefreshItem({
      workspaceId: wsId,
      productSku: sku,
      triggerType: 'primary_product_type_change',
      sourceKind: 'onboarding',
      onboardingItemId: itemId,
      expectedRunId: runId,
      requestedBy: 'test',
    });

    const claimed = claimRefreshBatch('worker-test', 10);
    expect(claimed.length).toBe(1);
    const queueItem = claimed[0];
    expect(queueItem.id).toBe(queueId);

    const processed = await processRefreshItem(queueItem);
    expect(processed).toBe(true);

    // Old dog proposal must be superseded
    const oldProp = db.query('SELECT status, superseded_at, refresh_queue_id FROM classification_proposals WHERE id = ?').get('prop-breed-size') as any;
    expect(oldProp.superseded_at).not.toBeNull();
    expect(oldProp.refresh_queue_id).toBe(queueItem!.id);

    // Mark-and-queue-only: the worker supersedes invalidated dependents but
    // never inserts placeholder field_assignment rows — recomputation is
    // owned by the real classification pipeline. No new proposal for
    // hairball_control (applicable to cat_food) may be fabricated here.
    const newProposals = db.query(
      `SELECT id, proposal_type, target_id, status, refresh_queue_id
       FROM classification_proposals
       WHERE run_id = ? AND superseded_at IS NULL AND target_id = 'hairball_control'`,
    ).all(runId) as any[];

    expect(newProposals.length).toBe(0);

    // Queue item must be completed with outcome_run_id
    const finishedQueueItem = db.query('SELECT status, outcome_run_id, completed_at FROM classification_refresh_queue WHERE id = ?').get(queueItem!.id) as any;
    expect(finishedQueueItem.status).toBe('completed');
    expect(finishedQueueItem.outcome_run_id).toBe(runId);
    expect(finishedQueueItem.completed_at).not.toBeNull();
  });
});
