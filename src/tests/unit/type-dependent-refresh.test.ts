import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createConfigSnapshot, syncConfigToCache, upsertConfigSnapshot } from '../../db/repositories/classification-config-repo';
import { generateCandidate, type BayStateSeed } from '../../classification/config-generator';
import type { CatalogEvidence } from '../../classification/catalog-evidence';
import { buildRuntimeSnapshot, persistRuntimeSnapshot, snapshotHash } from '../../classification/runtime-snapshot';
import { BayStatePetGardenSeed } from '../../classification/config-seeds/bay-state-pet-garden-v1';
import { enqueueRefreshItem, claimRefreshBatch } from '../../db/repositories/classification-refresh-repo';
import { processRefreshItem } from '../../classification/type-dependent-refresh';
import { overrideTypeFirstCurationFlags, resetTypeFirstCurationFlagsOverride } from '../../classification/flags';
import { refreshReviewedDependents } from '../../classification/refresh-reviewed-dependents';
import { findItemById } from '../../db/repositories/onboarding-item-repo';
import { capturePreReviewPrediction } from '../../classification/benchmark-prediction';
import { getProposalsByRun, getStageResults } from '../../db/repositories/classification-run-repo';
import { submitProposalDecisions } from '../../classification/proposal-review-service';
import { evaluateCanonicalReadiness } from '../../classification/classification-readiness';

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
      categories: [
        { id: 'dog_food_cat', name: 'Dog Food' },
        { id: 'cat_food_cat', name: 'Cat Food' },
      ],
      productTypes: [
        { id: 'dog_food', name: 'Dog Food', description: null, attributeProfileId: 'dog-profile', oldIdAliases: [], categoryId: 'dog_food_cat' },
        { id: 'cat_food', name: 'Cat Food', description: null, attributeProfileId: 'cat-profile', oldIdAliases: [], categoryId: 'cat_food_cat' },
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
  function loadV2BundleFixture() {
    const seed: BayStateSeed = {
      ...BayStatePetGardenSeed,
      name: 'Refresh V2 fixture',
      revision: 'refresh-v2',
      categories: [
        { id: 'dog_food_cat', name: 'Dog Food', description: null },
        { id: 'cat_food_cat', name: 'Cat Food', description: null },
      ],
      productTypes: [
        { id: 'dog_food', name: 'Dog Food', description: null, categoryId: 'dog_food_cat', websiteValues: { category: 'Dog Food', productType: 'Dog Food' } },
        { id: 'cat_food', name: 'Cat Food', description: null, categoryId: 'cat_food_cat', websiteValues: { category: 'Cat Food', productType: 'Cat Food' } },
      ],
      attributes: BayStatePetGardenSeed.attributes.filter(attribute =>
        ['brand', 'breed-size', 'flavor'].includes(attribute.id),
      ),
      profileTemplates: [
        { id: 'dog-profile', name: 'Dog Profile', productTypeIds: ['dog_food'], attributes: [{ attributeId: 'breed-size', cardinality: 'single' }] },
        { id: 'cat-profile', name: 'Cat Profile', productTypeIds: ['cat_food'], attributes: [{ attributeId: 'flavor', cardinality: 'single' }] },
      ],
      mappings: BayStatePetGardenSeed.mappings.filter(mapping =>
        ['brand', 'breed-size', 'flavor'].includes(mapping.attributeId),
      ),
      curationTargets: BayStatePetGardenSeed.curationTargets.filter(target =>
        target.kind === 'product_type' || ['brand', 'breed-size', 'flavor'].includes(target.attributeId ?? ''),
      ),
    };
    const evidence: CatalogEvidence = {
      schemaVersion: 1,
      sourceTreeHash: 'fixture',
      productFileCount: 0,
      parseFailureCount: 0,
      parseFailures: [],
      fieldRegistry: { entryCount: 0, xmlFields: [] },
      fields: [],
      pages: [],
    };
    return generateCandidate(seed, evidence).bundle;
  }
  function loadConditionalMaterialBundleFixture() {
    const species = BayStatePetGardenSeed.attributes.find(attribute => attribute.id === 'species')!;
    const material = BayStatePetGardenSeed.attributes.find(attribute => attribute.id === 'material')!;
    const seed: BayStateSeed = {
      ...BayStatePetGardenSeed,
      name: 'Conditional Material Refresh',
      revision: 'conditional-material-refresh',
      categories: [
        { id: 'dog_food_cat', name: 'Dog Food', description: null },
        { id: 'cat_food_cat', name: 'Cat Food', description: null },
      ],
      productTypes: [
        {
          id: 'dog_food',
          name: 'Dog Food',
          description: null,
          categoryId: 'dog_food_cat',
          websiteValues: { category: 'QA Dog Food', productType: 'QA Dry Dog Food' },
        },
        {
          id: 'cat_food',
          name: 'Cat Food',
          description: null,
          categoryId: 'cat_food_cat',
          websiteValues: { category: 'QA Cat Food', productType: 'QA Dry Cat Food' },
        },
      ],
      attributes: [
        { ...species, isUniversal: false },
        { ...material, valueMode: 'controlled', allowedValues: ['Nylon'], valueAliases: [], isUniversal: true },
      ],
      profileTemplates: [
        {
          id: 'cat-food-profile',
          name: 'Cat Food Profile',
          productTypeIds: ['cat_food'],
          attributes: [
            { attributeId: 'species', required: false, cardinality: 'single', applicabilityConditions: [] },
            { attributeId: 'material', required: true, cardinality: 'single', applicabilityConditions: [] },
          ],
        },
        {
          id: 'dog-food-profile',
          name: 'Dog Food Profile',
          productTypeIds: ['dog_food'],
          attributes: [
            { attributeId: 'species', required: false, cardinality: 'single', applicabilityConditions: [] },
            {
              attributeId: 'material',
              required: true,
              cardinality: 'single',
              applicabilityConditions: [{
                operator: 'equals',
                attributeId: 'species',
                value: 'Dog',
                factSource: 'accepted_reviewed',
              }],
            },
          ],
        },
      ],
      mappings: BayStatePetGardenSeed.mappings.filter(mapping => ['species', 'material'].includes(mapping.attributeId)),
      classificationOutputBindings: [
        { role: 'category', catalogField: 'ProductField24', serialization: { kind: 'scalar', prefix: '', suffix: '' }, isStale: false },
        { role: 'product-type', catalogField: 'ProductField25', serialization: { kind: 'scalar', prefix: '', suffix: '' }, isStale: false },
      ],
      curationTargets: BayStatePetGardenSeed.curationTargets.filter(target =>
        target.kind === 'product_type' || ['species', 'material'].includes(target.attributeId ?? ''),
      ),
    };
    const evidence: CatalogEvidence = {
      schemaVersion: 1,
      sourceTreeHash: 'conditional-material-fixture',
      productFileCount: 0,
      parseFailureCount: 0,
      parseFailures: [],
      fieldRegistry: { entryCount: 0, xmlFields: [] },
      fields: [],
      pages: [],
    };
    return generateCandidate(seed, evidence).bundle;
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
    const baseRuntime = buildRuntimeSnapshot({
      workspaceId: wsId,
      workspacePath: '/tmp/refresh',
      productSku: sku,
      config,
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
      sourceProductHash: 'hash-sku-recomp',
    });
    const { snapshotHash: recomputeHash2, deepFreeze: deepFreeze2 } = await import('../../classification/runtime-snapshot');
    const runtime = {
      ...structuredClone(baseRuntime),
      categories: [
        { id: 'dog_food_cat', name: 'Dog Food' },
        { id: 'cat_food_cat', name: 'Cat Food' },
      ],
    };
    (runtime as { productTypes: unknown }).productTypes = (runtime.productTypes as Array<Record<string, unknown>>).map((t) => {
      if (t.id === 'dog_food') return { ...t, categoryId: 'dog_food_cat' };
      if (t.id === 'cat_food') return { ...t, categoryId: 'cat_food_cat' };
      return { ...t };
    });
    (runtime as { snapshotHash: string }).snapshotHash = recomputeHash2(runtime as never);
    persistRuntimeSnapshot(deepFreeze2(runtime as never));

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
       VALUES (?, ?, ?, 'product_classification', 'cat_food', '{"categoryId":"cat_food_cat","productTypeId":"cat_food"}', 0.9, 'accepted', datetime('now'))`,
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

  it('refreshes gated attributes from persisted evidence without rerunning OCR, name or type or losing accepted universals', async () => {
    const db = getDb();
    const batchId = randomUUID();
    const itemId = randomUUID();
    const runId = randomUUID();
    const sku = 'SKU-ACCEPT-UNCHANGED';
    const bundle = loadV2BundleFixture();
    const ref = upsertConfigSnapshot(wsId, bundle);
    const snapshot = buildRuntimeSnapshot({
      workspaceId: wsId,
      workspacePath: '/tmp/refresh',
      productSku: sku,
      authority: { kind: 'v2', bundle },
      configSnapshotRef: { id: ref.id, hash: ref.hash, sourceCommit: null, createdAt: new Date().toISOString() },
      sourceProductHash: '',
    });
    persistRuntimeSnapshot(snapshot);
    db.run(`INSERT INTO onboarding_batches (id, workspace_id, name, file_name, created_at, updated_at)
      VALUES (?, ?, 'Accept unchanged', 'fixture', datetime('now'), datetime('now'))`, [batchId, wsId]);
    db.run(`INSERT INTO onboarding_items (id, batch_id, row_number, upc, name, stage, stage_status, curation_data_json, created_at, updated_at)
      VALUES (?, ?, 1, ?, 'Fixture', 'review', 'pending', ?, datetime('now'), datetime('now'))`,
    [itemId, batchId, sku, JSON.stringify({ classificationRunId: runId, curatedTitle: 'Keep this name' })]);
    db.run(`INSERT INTO classification_runs (id, workspace_id, onboarding_item_id, product_sku, status, config_snapshot_hash, started_at)
      VALUES (?, ?, ?, ?, 'completed', ?, datetime('now'))`, [runId, wsId, itemId, sku, snapshot.snapshotHash]);
    const typeId = randomUUID();
    const brandId = randomUUID();
    for (const [id, proposalType, targetId, value] of [[typeId, 'product_classification', 'dog_food', { categoryId: 'dog_food_cat', productTypeId: 'dog_food' }], [brandId, 'field_assignment', 'brand', 'Acme']] as const) {
      db.run(`INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 'accepted', datetime('now'))`, [id, runId, sku, proposalType, targetId, JSON.stringify(value)]);
      db.run(`INSERT INTO classification_proposal_decisions (id, proposal_id, decision, reviewer_id, decision_origin, created_at)
        VALUES (?, ?, 'accepted', 'nick', 'human_review', datetime('now'))`, [randomUUID(), id]);
    }
    db.run(`INSERT INTO classification_evidence (id, run_id, onboarding_item_id, product_sku, stage_name, source, reliability, attribute_id, source_field, snippet, value_json, metadata_json, created_at)
      VALUES (?, ?, ?, ?, 'evidence_extraction', 'official_product_page', 'high', 'breed-size', 'BreedSize', 'Small', '"Small"', '{}', datetime('now'))`, [randomUUID(), runId, itemId, sku]);
    const oldDependentId = randomUUID();
    db.run(`INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
      VALUES (?, ?, ?, 'field_assignment', 'breed-size', '"Large"', 0.8, 'pending', datetime('now'))`, [oldDependentId, runId, sku]);
    const originalPrediction = capturePreReviewPrediction({ runId, workspaceId: wsId, productSku: sku });
    expect(originalPrediction.fieldAssignments.find(field => field.targetId === 'breed-size')?.value).toBe('Large');
    db.exec(`CREATE TRIGGER reject_refresh_value BEFORE INSERT ON classification_proposals
      WHEN NEW.target_id = 'breed-size' BEGIN SELECT RAISE(ABORT, 'fixture refresh commit failure'); END`);
    await expect(refreshReviewedDependents({ runId, workspaceId: wsId, itemId })).rejects.toThrow('fixture refresh commit failure');
    expect(db.query('SELECT superseded_at, status FROM classification_proposals WHERE id = ?').get(oldDependentId)).toEqual({ superseded_at: null, status: 'pending' });
    db.exec('DROP TRIGGER reject_refresh_value');
    const beforeCalls = db.query('SELECT COUNT(*) AS n FROM classification_model_calls WHERE run_id = ?').get(runId) as { n: number };
    const pendingRefresh = refreshReviewedDependents({ runId, workspaceId: wsId, itemId });
    await expect(refreshReviewedDependents({ runId, workspaceId: wsId, itemId })).rejects.toThrow('already in progress');
    const result = await pendingRefresh;
    expect(result.runId).toBe(runId);
    const afterCalls = db.query('SELECT COUNT(*) AS n FROM classification_model_calls WHERE run_id = ?').get(runId) as { n: number };
    expect(afterCalls.n).toBe(beforeCalls.n);
    expect(findItemById(itemId)?.curationData?.curatedTitle).toBe('Keep this name');
    expect(findItemById(itemId)?.curationData?.classificationRunId).toBe(runId);
    const newValue = db.query(`SELECT proposed_value_json, status FROM classification_proposals WHERE run_id = ? AND target_id = 'breed-size' AND superseded_at IS NULL`).get(runId) as { proposed_value_json: string; status: string };
    expect(JSON.parse(newValue.proposed_value_json)).toBe('Small');
    expect(newValue.status).toBe('pending');
    expect(db.query('SELECT superseded_at, status FROM classification_proposals WHERE id = ?').get(brandId)).toEqual({ superseded_at: null, status: 'accepted' });
    expect(db.query(`SELECT COUNT(*) AS n FROM classification_proposals WHERE run_id = ? AND proposal_type = 'product_classification'`).get(runId)).toEqual({ n: 1 });
    expect(capturePreReviewPrediction({ runId, workspaceId: wsId, productSku: sku }).failureCode).toBe('post_review_refresh');
  });
  it('uses accepted universal facts to generate newly applicable required attributes during review refresh', async () => {
    const db = getDb();
    const batchId = randomUUID();
    const itemId = randomUUID();
    const runId = randomUUID();
    const sku = `SKU-CONDITIONAL-${randomUUID().slice(0, 8)}`;
    const bundle = loadConditionalMaterialBundleFixture();
    syncConfigToCache(wsId, bundle as unknown as Parameters<typeof syncConfigToCache>[1]);
    const ref = upsertConfigSnapshot(wsId, bundle);
    const snapshot = structuredClone(buildRuntimeSnapshot({
      workspaceId: wsId,
      workspacePath: '/tmp/refresh',
      productSku: sku,
      authority: { kind: 'v2', bundle },
      configSnapshotRef: { id: ref.id, hash: ref.hash, sourceCommit: null, createdAt: new Date().toISOString() },
      sourceProductHash: '',
    }));
    snapshot.snapshotHash = snapshotHash(snapshot);
    persistRuntimeSnapshot(snapshot);
    db.run(`INSERT INTO onboarding_batches (id, workspace_id, name, file_name, created_at, updated_at)
      VALUES (?, ?, 'Conditional refresh', 'fixture', datetime('now'), datetime('now'))`, [batchId, wsId]);
    db.run(`INSERT INTO onboarding_items (id, batch_id, row_number, upc, name, stage, stage_status, curation_data_json, created_at, updated_at)
      VALUES (?, ?, 1, ?, 'Dog food', 'review', 'pending', ?, datetime('now'), datetime('now'))`,
    [itemId, batchId, sku, JSON.stringify({ classificationRunId: runId })]);
    db.run(`INSERT INTO classification_runs
      (id, workspace_id, onboarding_item_id, source_kind, product_sku, status, config_snapshot_hash, started_at, completed_at)
      VALUES (?, ?, ?, 'onboarding', ?, 'completed', ?, datetime('now'), datetime('now'))`,
    [runId, wsId, itemId, sku, snapshot.snapshotHash]);

    const pairId = randomUUID();
    const speciesId = randomUUID();
    const materialId = randomUUID();
    for (const [id, type, targetId, value] of [
      [pairId, 'product_classification', 'cat_food', { categoryId: 'cat_food_cat', productTypeId: 'cat_food' }],
      [speciesId, 'field_assignment', 'species', 'Dog'],
      [materialId, 'field_assignment', 'material', 'Nylon'],
    ] as const) {
      db.run(`INSERT INTO classification_proposals
        (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', datetime('now'))`,
      [id, runId, sku, type, targetId, JSON.stringify(value)]);
    }
    db.run(`INSERT INTO classification_evidence
      (id, run_id, onboarding_item_id, product_sku, stage_name, source, reliability, attribute_id, source_field, snippet, value_json, metadata_json, created_at)
      VALUES (?, ?, ?, ?, 'evidence_extraction', 'official_product_page', 'high', 'material', 'ProductField28', 'Nylon', '"Nylon"', '{}', datetime('now'))`,
    [randomUUID(), runId, itemId, sku]);

    const initialReview = submitProposalDecisions({
      workspaceId: wsId,
      productSku: sku,
      runId,
      sourceKind: 'onboarding',
      onboardingItemId: itemId,
      decisions: [
        { proposalId: pairId, decision: 'accepted' },
        { proposalId: speciesId, decision: 'accepted' },
        { proposalId: materialId, decision: 'accepted' },
      ],
    });
    expect(initialReview.ok).toBe(true);
    const pairDecisionRevision = getProposalsByRun(runId).find(proposal => proposal.id === pairId)?.currentDecisionId;
    expect(pairDecisionRevision).toBeTruthy();
    const correctedPair = submitProposalDecisions({
      workspaceId: wsId, productSku: sku, runId, sourceKind: 'onboarding', onboardingItemId: itemId,
      decisions: [{
        proposalId: pairId, decision: 'accepted', expectedRevisionId: pairDecisionRevision!,
        revisedTargetId: 'dog_food',
        revisedValue: { categoryId: 'dog_food_cat', productTypeId: 'dog_food' },
      }],
    });
    expect(correctedPair.ok).toBe(true);
    expect(getProposalsByRun(runId).find(proposal => proposal.id === speciesId)?.status).toBe('accepted');
    expect(getProposalsByRun(runId).find(proposal => proposal.id === materialId)?.status).toBe('stale');
    await refreshReviewedDependents({ runId, workspaceId: wsId, itemId });
    const speciesProposal = getProposalsByRun(runId).find(proposal => proposal.id === speciesId);
    expect(speciesProposal?.status).toBe('accepted');
    expect(speciesProposal?.currentDecisionId).toBeTruthy();
    expect(getProposalsByRun(runId).filter(proposal =>
      proposal.proposalType === 'field_assignment' && proposal.targetId === 'species' && proposal.status === 'pending',
    )).toHaveLength(0);
    expect(db.query('SELECT superseded_at FROM classification_proposals WHERE id = ?').get(materialId))
      .toMatchObject({ superseded_at: expect.any(String) });
    const applicabilityResult = getStageResults(runId).find(stage => stage.stage_name === 'attribute_applicability');
    const materialApplicability = JSON.parse(applicabilityResult!.output_json!).metadata.applicability.find(
      (entry: { attributeId: string }) => entry.attributeId === 'material',
    );
    expect(materialApplicability).toMatchObject({ attributeId: 'material', state: 'applicable' });
    const materialProposal = getProposalsByRun(runId).find(proposal =>
      proposal.proposalType === 'field_assignment' && proposal.targetId === 'material' && proposal.status === 'pending',
    );
    expect(materialProposal?.proposedValue).toBe('Nylon');
    const readiness = evaluateCanonicalReadiness({ workspaceId: wsId, runId });
    expect(readiness.ok).toBe(false);
    if (!readiness.ok) {
      expect(readiness.details.requiredValues.find(value => value.attributeId === 'material')?.status).toBe('missing');
    }

    const materialReview = submitProposalDecisions({
      workspaceId: wsId,
      productSku: sku,
      runId,
      sourceKind: 'onboarding',
      onboardingItemId: itemId,
      decisions: [{ proposalId: materialProposal!.id, decision: 'accepted' }],
    });
    expect(materialReview.ok).toBe(true);
    expect(evaluateCanonicalReadiness({ workspaceId: wsId, runId }).ok).toBe(true);
    const currentSpeciesDecisionId = getProposalsByRun(runId).find(proposal => proposal.id === speciesId)?.currentDecisionId;
    expect(currentSpeciesDecisionId).toBeTruthy();
    const removedSpeciesReview = submitProposalDecisions({
      workspaceId: wsId,
      productSku: sku,
      runId,
      sourceKind: 'onboarding',
      onboardingItemId: itemId,
      decisions: [{ proposalId: speciesId, decision: 'rejected', expectedRevisionId: currentSpeciesDecisionId! }],
    });
    expect(removedSpeciesReview.ok).toBe(true);
    const malformedSpeciesId = randomUUID();
    db.run(`INSERT INTO classification_proposals
      (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
      VALUES (?, ?, ?, 'field_assignment', 'species', ?, 1, 'pending', datetime('now'))`,
    [malformedSpeciesId, runId, sku, JSON.stringify(['Dog', '  '])]);
    const malformedSpeciesReview = submitProposalDecisions({
      workspaceId: wsId,
      productSku: sku,
      runId,
      sourceKind: 'onboarding',
      onboardingItemId: itemId,
      decisions: [{ proposalId: malformedSpeciesId, decision: 'accepted' }],
    });
    expect(malformedSpeciesReview.ok).toBe(true);
    const invalidatedReadiness = evaluateCanonicalReadiness({ workspaceId: wsId, runId });
    expect(invalidatedReadiness).toMatchObject({ ok: false, code: 'required_values_missing' });
    if (!invalidatedReadiness.ok) {
      expect(invalidatedReadiness.details.requiredValues.find(value => value.attributeId === 'material')?.status)
        .toBe('required_unknown');
    }
  });
});
