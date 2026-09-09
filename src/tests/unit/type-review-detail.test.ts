import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createConfigSnapshot } from '../../db/repositories/classification-config-repo';
import { buildRuntimeSnapshot, persistRuntimeSnapshot } from '../../classification/runtime-snapshot';
import { computeTypeReviewDetail } from '../../classification/type-review-detail';
import { TypeReviewDetailSchema } from '../../shared/schemas/classification';

describe('type-review-detail (P1.3)', () => {
  const dbPath = `/tmp/test-type-review-${randomUUID()}.db`;
  const wsId = 'ws-type-review-test';

  beforeAll(() => {
    initDb(dbPath);
    runMigrations();
  });

  afterAll(() => {
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
        { id: 'dog_food', name: 'Dog Food', description: null, attributeProfileId: 'dog-profile', oldIdAliases: [], departmentId: 'pets' },
        { id: 'cat_food', name: 'Cat Food', description: null, attributeProfileId: 'cat-profile', oldIdAliases: [], departmentId: 'pets' },
      ],
      attributes: [
        { id: 'brand', name: 'Brand', description: null, valueMode: 'freeText', canonicalUnit: null, allowedValues: [], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, isUniversal: true, group: 'Identity' },
      ],
      attributeProfiles: [
        { id: 'dog-profile', productTypeId: 'dog_food', name: 'Dog Profile', attributes: [] },
        { id: 'cat-profile', productTypeId: 'cat_food', name: 'Cat Profile', attributes: [] },
      ],
      attributeMappings: [],
      curationTargets: [
        { id: 'primary-product-type', kind: 'product_type', label: 'Primary Product Type', enabled: true, selectionMode: 'single', attributeId: null, catalogField: null, optionSource: 'configured', required: false, mandatory: false, sortOrder: 0 },
      ],
      brands: [],
      guidance: [],
      modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only', textDataSharing: 'local_only' },
      dataSharing: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
    };
  }

  it('assembles complete TypeReviewDetail matching schema and invariants', () => {
    const db = getDb();
    const now = new Date().toISOString();

    insertWorkspace({
      id: wsId,
      name: 'Test Workspace',
      workspacePath: '/tmp/test',
      gitPath: '/tmp/test',
      baselineCommit: null,
      bootstrapStatus: 'complete',
      createdAt: now,
      updatedAt: now,
    });

    const sku = '012345678901';
    const bundle = loadConfigFixture();
    const { id: snapId, hash: snapHash } = createConfigSnapshot(wsId, bundle);
    const snap = buildRuntimeSnapshot({
      workspaceId: wsId,
      workspacePath: '/tmp/test',
      productSku: sku,
      config: bundle,
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
      sourceProductHash: 'cat-hash',
    });
    persistRuntimeSnapshot(snap);

    const itemId = `item-${randomUUID()}`;
    const batchId = `batch-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;

    db.query(`INSERT INTO onboarding_batches (id, workspace_id, name, file_name, created_at, updated_at) VALUES (?, ?, 'Batch 1', 'b.csv', ?, ?)`).run(
      batchId,
      wsId,
      now,
      now,
    );

    db.query(
      `INSERT INTO onboarding_items (id, batch_id, row_number, upc, name, status, stage, stage_status, created_at, updated_at)
       VALUES (?, ?, 1, ?, 'Dog Food 5lb', 'pending', 'curation', 'pending', ?, ?)`,
    ).run(itemId, batchId, sku, now, now);

    db.query(
      `INSERT INTO classification_runs (id, workspace_id, product_sku, status, config_snapshot_hash, started_at, completed_at)
       VALUES (?, ?, ?, 'completed', ?, ?, ?)`,
    ).run(runId, wsId, sku, snap.snapshotHash, now, now);

    const typePropId = `prop-${randomUUID()}`;
    db.query(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, is_bulk_acceptable, is_stale, created_at)
       VALUES (?, ?, ?, 'primary_product_type', 'dog_food', ?, 0.95, 'pending', 0, 0, ?)`,
    ).run(typePropId, runId, sku, JSON.stringify({ productTypeId: 'dog_food', productTypeName: 'Dog Food' }), now);

    // Initial unreviewed state: execution preview available, reviewed is null, blocked
    const initialDetail = computeTypeReviewDetail(db, wsId, itemId, sku, runId);
    expect(initialDetail).not.toBeNull();
    const parseResult1 = TypeReviewDetailSchema.safeParse(initialDetail);
    expect(parseResult1.success).toBe(true);

    expect(initialDetail!.reviewed.id).toBeNull();
    expect(initialDetail!.reviewed.current).toBe(false);
    expect(initialDetail!.executionPreview).toEqual({
      id: 'dog_food',
      label: 'Dog Food',
      confidence: 0.95,
      previewOnly: true,
    });
    expect(initialDetail!.refreshState).toBe('blocked');
    expect(initialDetail!.options.length).toBe(2);
    expect(initialDetail!.options.find(o => o.id === 'dog_food')?.hierarchyPath).toEqual(['pets', 'Dog Food']);

    // Now record a human review decision accepting dog_food
    const decId = `dec-${randomUUID()}`;
    db.query(
      `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, decision_origin, reviewer_id, created_at)
       VALUES (?, ?, 'accepted', 'human_review', 'operator-1', ?)`,
    ).run(decId, typePropId, now);

    const reviewedDetail = computeTypeReviewDetail(db, wsId, itemId, sku, runId);
    expect(reviewedDetail).not.toBeNull();
    const parseResult2 = TypeReviewDetailSchema.safeParse(reviewedDetail);
    expect(parseResult2.success).toBe(true);

    expect(reviewedDetail!.reviewed.id).toBe('dog_food');
    expect(reviewedDetail!.reviewed.label).toBe('Dog Food');
    expect(reviewedDetail!.reviewed.current).toBe(true);
    expect(reviewedDetail!.refreshState).toBe('current');

    // Enqueue a refresh item: status becomes queued
    db.query(
      `INSERT INTO classification_refresh_queue (id, workspace_id, product_sku, source_kind, onboarding_item_id, expected_run_id, trigger_type, status, requested_at)
       VALUES (?, ?, ?, 'onboarding', ?, ?, 'primary_product_type_change', 'queued', ?)`,
    ).run(`ref-${randomUUID()}`, wsId, sku, itemId, runId, now);

    const queuedDetail = computeTypeReviewDetail(db, wsId, itemId, sku, runId);
    expect(queuedDetail!.refreshState).toBe('queued');
  });
});
