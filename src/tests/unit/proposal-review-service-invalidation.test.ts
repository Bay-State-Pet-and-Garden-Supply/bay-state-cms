import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { initDb, getDb, closeDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { submitProposalDecisions } from '../../classification/proposal-review-service';
import { markReviewed, getReviewState } from '../../db/repositories/onboarding-review-repo';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createConfigSnapshot } from '../../db/repositories/classification-config-repo';
import { buildRuntimeSnapshot, persistRuntimeSnapshot, snapshotHash } from '../../classification/runtime-snapshot';

describe('proposal-review-service invalidation & guardrails (P1.2)', () => {
  const dbPath = `/tmp/test-review-invalidation-${randomUUID()}.db`;
  const wsId = 'ws-test';

  beforeAll(() => {
    initDb(dbPath);
    runMigrations();
    insertWorkspace({ id: wsId, name: 'Test WS', workspacePath: '/tmp/test', gitPath: '/tmp/test/.git',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bootstrapStatus: 'complete', baselineCommit: null });
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
        { id: 'dog_food', name: 'Dog Food', description: null, attributeProfileId: 'dog-profile', oldIdAliases: [], categoryId: 'dog_food_cat' },
        { id: 'cat_food', name: 'Cat Food', description: null, attributeProfileId: 'cat-profile', oldIdAliases: [], categoryId: 'cat_food_cat' },
      ],
      categories: [
        { id: 'dog_food_cat', name: 'Dog Food' },
        { id: 'cat_food_cat', name: 'Cat Food' },
      ],
      attributes: [
        { id: 'brand', name: 'Brand', description: null, valueMode: 'freeText', canonicalUnit: null, allowedValues: [], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, isUniversal: true, group: 'Identity' },
        { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled', canonicalUnit: null, allowedValues: ['Chicken', 'Beef'], valueAliases: [], visualEvidenceEligibility: 'eligible', isClaim: false, isCompositionAttribute: false, isUniversal: false, group: 'Food' },
      ],
      attributeProfiles: [
        { id: 'dog-profile', productTypeId: 'dog_food', name: 'Dog Profile', attributes: [{ attributeId: 'flavor', required: true, cardinality: 'single', applicabilityConditions: [], constraints: {}, confidenceThresholds: {}, valueAliases: [] }] },
        { id: 'cat-profile', productTypeId: 'cat_food', name: 'Cat Profile', attributes: [] },
      ],
      attributeMappings: [
        { id: 'brand-map', attributeId: 'brand', catalogField: 'Brand', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
        { id: 'flavor-map', attributeId: 'flavor', catalogField: 'Flavor', serialization: { format: 'direct', separator: ', ', prefix: '', suffix: '' }, isStale: false },
      ],
      curationTargets: [
        { id: 'primary-product-type', kind: 'product_type', label: 'Primary Product Type', enabled: true, selectionMode: 'single', attributeId: null, catalogField: null, optionSource: 'configured', required: false, mandatory: false, sortOrder: 0 },
        { id: 'brand-target', kind: 'product_field', label: 'Brand', enabled: true, selectionMode: 'single', attributeId: 'brand', catalogField: 'Brand', optionSource: 'configured', required: false, mandatory: false, sortOrder: 1 },
        { id: 'flavor-target', kind: 'product_field', label: 'Flavor', enabled: true, selectionMode: 'single', attributeId: 'flavor', catalogField: 'Flavor', optionSource: 'configured', required: false, mandatory: false, sortOrder: 2 },
      ],
      brands: [],
      guidance: [],
      modelPolicy: { defaultProvider: 'ollama', defaultModel: '', stageOverrides: {}, imageDataSharing: 'local_only', textDataSharing: 'local_only' },
      dataSharing: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
    };
  }

  it('rejects decisions submitted against stale or superseded proposals', () => {
    const db = getDb();
    const batchId = randomUUID();
    const itemId = randomUUID();
    const runId = randomUUID();
    const sku = 'SKU-INVAL-1';

    db.run(
      `INSERT INTO onboarding_batches (id, workspace_id, name, file_name, created_at, updated_at)
       VALUES (?, ?, 'Batch 1', 'test.csv', datetime('now'), datetime('now'))`,
      [batchId, wsId],
    );
    db.run(
      `INSERT INTO onboarding_items (id, batch_id, row_number, upc, name, stage, stage_status, created_at, updated_at)
       VALUES (?, ?, 1, ?, 'Test Dog Food', 'review', 'ready', datetime('now'), datetime('now'))`,
      [itemId, batchId, sku],
    );
    db.run(
      `INSERT INTO classification_runs (id, workspace_id, onboarding_item_id, product_sku, status, started_at, completed_at)
       VALUES (?, ?, ?, ?, 'completed', datetime('now'), datetime('now'))`,
      [runId, wsId, itemId, sku],
    );

    // Stale proposal
    db.run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, is_stale, staleness_reason, created_at)
       VALUES (?, ?, ?, 'field_assignment', 'flavor', '"Beef"', 0.8, 'stale', 1, 'product_type_changed', datetime('now'))`,
      ['prop-stale', runId, sku],
    );

    // Superseded proposal
    db.run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, superseded_at, created_at)
       VALUES (?, ?, ?, 'field_assignment', 'flavor', '"Chicken"', 0.8, 'pending', datetime('now'), datetime('now'))`,
      ['prop-superseded', runId, sku],
    );

    const staleResult = submitProposalDecisions({
      workspaceId: wsId,
      productSku: sku,
      runId,
      sourceKind: 'onboarding',
      onboardingItemId: itemId,
      decisions: [
        {
          proposalId: 'prop-stale',
          decision: 'accepted',
        },
      ],
    });

    expect(staleResult.ok).toBe(false);
    if (!staleResult.ok) {
      expect(staleResult.code).toBe('decision_conflict');
      expect(staleResult.reason).toContain('stale');
    }

    const supersededResult = submitProposalDecisions({
      workspaceId: wsId,
      productSku: sku,
      runId,
      sourceKind: 'onboarding',
      onboardingItemId: itemId,
      decisions: [
        {
          proposalId: 'prop-superseded',
          decision: 'accepted',
        },
      ],
    });

    expect(supersededResult.ok).toBe(false);
    if (!supersededResult.ok) {
      expect(supersededResult.code).toBe('decision_conflict');
      expect(supersededResult.reason).toContain('superseded');
    }
  });

  it('atomically invalidates dependent proposals, supersedes decisions, invalidates review state, stamps human origin, and enqueues recompute on type change', () => {
    const db = getDb();
    const runId = randomUUID();
    const batchId = randomUUID();
    const itemId = randomUUID();

    const config = loadConfigFixture();
    const { id: snapId, hash: snapHash } = createConfigSnapshot(wsId, config);
    const runtime = buildRuntimeSnapshot({
      workspaceId: wsId,
      workspacePath: '/tmp/fixture',
      productSku: '012345678901',
      config,
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
      sourceProductHash: 'hash-dog-food',
    });
    const patchedRuntime = {
      ...runtime,
      categories: [
        { id: 'dog_food_cat', name: 'Dog Food' },
        { id: 'cat_food_cat', name: 'Cat Food' },
      ],
      productTypes: runtime.productTypes.map((t) => {
        const rec = t as { id: string; categoryId?: string };
        if (rec.id === 'dog_food') return { ...rec, categoryId: 'dog_food_cat' };
        if (rec.id === 'cat_food') return { ...rec, categoryId: 'cat_food_cat' };
        return { ...rec };
      }),
    };
    patchedRuntime.snapshotHash = snapshotHash(patchedRuntime as never);
    persistRuntimeSnapshot(patchedRuntime as never);

    db.run(
      `INSERT INTO onboarding_batches (id, workspace_id, name, file_name, created_at, updated_at)
       VALUES (?, ?, 'Batch 2', 'test2.csv', datetime('now'), datetime('now'))`,
      [batchId, wsId],
    );
    db.run(
      `INSERT INTO onboarding_items (id, batch_id, row_number, upc, name, stage, stage_status, created_at, updated_at)
       VALUES (?, ?, 1, '012345678901', 'Test Dog Food', 'review', 'ready', datetime('now'), datetime('now'))`,
      [itemId, batchId],
    );
    db.run(
      `INSERT INTO classification_runs (id, workspace_id, onboarding_item_id, product_sku, status, config_snapshot_hash, started_at, completed_at)
       VALUES (?, ?, ?, '012345678901', 'completed', ?, datetime('now'), datetime('now'))`,
      [runId, wsId, itemId, patchedRuntime.snapshotHash],
    );

    // Initial Primary Product Type proposal: dog_food
    db.run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, '012345678901', 'product_classification', 'dog_food', '{"categoryId":"dog_food_cat","productTypeId":"dog_food"}', 0.9, 'pending', datetime('now'))`,
      ['prop-type', runId],
    );

    // Universal attribute proposal: brand
    db.run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, '012345678901', 'field_assignment', 'brand', '"Purina"', 0.95, 'accepted', datetime('now'))`,
      ['prop-brand', runId],
    );
    db.run(
      `INSERT INTO classification_proposal_decisions
       (id, proposal_id, decision, decision_origin, created_at)
       VALUES (?, 'prop-brand', 'accepted', 'human_review', datetime('now'))`,
      [randomUUID()],
    );

    // Dependent attribute proposal: flavor (depends on dog_food)
    db.run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, '012345678901', 'field_assignment', 'flavor', '"Beef"', 0.85, 'accepted', datetime('now'))`,
      ['prop-flavor', runId],
    );
    const flavorDecId = randomUUID();
    db.run(
      `INSERT INTO classification_proposal_decisions
       (id, proposal_id, decision, decision_origin, created_at)
       VALUES (?, 'prop-flavor', 'accepted', 'human_review', datetime('now'))`,
      [flavorDecId],
    );
    db.run(
      `INSERT INTO classification_proposal_dependencies
       (workspace_id, proposal_id, dependency_kind, dependency_target_id, dependency_value_hash, created_at)
       VALUES (?, 'prop-flavor', 'reviewed_product_type', 'dog_food', 'hash-dog-food', datetime('now'))`,
      [wsId],
    );

    // Mark item reviewed initially
    markReviewed({ itemId, batchId, reviewedBy: 'reviewer-1' });

    // Change Product Type from dog_food to cat_food
    const result = submitProposalDecisions({
      workspaceId: wsId,
      productSku: '012345678901',
      runId,
      sourceKind: 'onboarding',
      onboardingItemId: itemId,
      decisions: [
        {
          proposalId: 'prop-type',
          decision: 'accepted',
          revisedTargetId: 'cat_food',
          revisedValue: { categoryId: 'cat_food_cat', productTypeId: 'cat_food' },
          reviewerId: 'reviewer-human',
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decisions.length).toBe(1);
      expect(result.decisions[0].decisionOrigin).toBe('human_review');
    }

    // Check dependent flavor proposal is staled
    const flavorProp = db.query('SELECT status, is_stale, staleness_reason FROM classification_proposals WHERE id = ?').get('prop-flavor') as any;
    expect(flavorProp.status).toBe('stale');
    expect(flavorProp.is_stale).toBe(1);
    expect(flavorProp.staleness_reason).toBe('product_type_changed');

    // Check flavor decision is superseded
    const flavorDec = db.query('SELECT superseded_at FROM classification_proposal_decisions WHERE id = ?').get(flavorDecId) as any;
    expect(flavorDec.superseded_at).not.toBeNull();

    // Check universal brand proposal is STILL accepted
    const brandProp = db.query('SELECT status, is_stale FROM classification_proposals WHERE id = ?').get('prop-brand') as any;
    expect(brandProp.status).toBe('accepted');
    expect(brandProp.is_stale).toBe(0);

    // Check review state is invalidated
    const reviewState = getReviewState(itemId);
    expect(reviewState?.reviewInvalidatedAt).not.toBeNull();
    expect(reviewState?.reviewInvalidationReason).toBe('product_type_changed');

    // Check classification_refresh_queue has pending recompute job
    const refreshItem = db.query(
      'SELECT trigger_type, requested_by, status FROM classification_refresh_queue WHERE onboarding_item_id = ?',
    ).get(itemId) as any;
    expect(refreshItem).toBeDefined();
    expect(refreshItem.trigger_type).toBe('primary_product_type_change');
    expect(refreshItem.status).toBe('queued');
  });

  function createReviewFixture(dependentAccepted = true) {
    const db = getDb();
    const runId = randomUUID();
    const batchId = randomUUID();
    const itemId = randomUUID();
    const typeProposalId = randomUUID();
    const fieldProposalId = randomUUID();
    const fieldDecisionId = randomUUID();
    const sku = `REVIEW-${randomUUID()}`;
    const config = loadConfigFixture();
    const ref = createConfigSnapshot(wsId, config);
    const snapshot = buildRuntimeSnapshot({ workspaceId: wsId, workspacePath: '/tmp/test', productSku: sku,
      config, configSnapshotRef: { id: ref.id, hash: ref.hash, sourceCommit: null, createdAt: new Date().toISOString() }, sourceProductHash: sku });
    const patchedSnapshot = {
      ...snapshot,
      categories: [
        { id: 'dog_food_cat', name: 'Dog Food' },
        { id: 'cat_food_cat', name: 'Cat Food' },
      ],
      productTypes: snapshot.productTypes.map((t) => {
        const rec = t as { id: string; categoryId?: string };
        if (rec.id === 'dog_food') return { ...rec, categoryId: 'dog_food_cat' };
        if (rec.id === 'cat_food') return { ...rec, categoryId: 'cat_food_cat' };
        return { ...rec };
      }),
    };
    patchedSnapshot.snapshotHash = snapshotHash(patchedSnapshot as never);
    persistRuntimeSnapshot(patchedSnapshot as never);
    db.run(`INSERT INTO onboarding_batches (id, workspace_id, name, file_name, created_at, updated_at)
      VALUES (?, ?, 'Review fixture', 'fixture', datetime('now'), datetime('now'))`, [batchId, wsId]);
    db.run(`INSERT INTO onboarding_items (id, batch_id, row_number, upc, name, stage, stage_status, curation_data_json, created_at, updated_at)
      VALUES (?, ?, 1, ?, 'Fixture', 'review', 'pending', ?, datetime('now'), datetime('now'))`,
    [itemId, batchId, sku, JSON.stringify({ classificationRunId: runId })]);
    db.run(`INSERT INTO classification_runs (id, workspace_id, onboarding_item_id, product_sku, status, config_snapshot_hash, started_at)
      VALUES (?, ?, ?, ?, 'completed', ?, datetime('now'))`, [runId, wsId, itemId, sku, patchedSnapshot.snapshotHash]);
    db.run(`INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
      VALUES (?, ?, ?, 'product_classification', 'dog_food', '{"categoryId":"dog_food_cat","productTypeId":"dog_food"}', 0.9, 'pending', datetime('now'))`, [typeProposalId, runId, sku]);
    db.run(`INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
      VALUES (?, ?, ?, 'field_assignment', 'flavor', '"Chicken"', 0.9, ?, datetime('now'))`, [fieldProposalId, runId, sku, dependentAccepted ? 'accepted' : 'pending']);
    if (dependentAccepted) {
      db.run(`INSERT INTO classification_proposal_decisions (id, proposal_id, decision, reviewer_id, decision_origin, created_at)
        VALUES (?, ?, 'accepted', 'nick', 'human_review', datetime('now'))`, [fieldDecisionId, fieldProposalId]);
      markReviewed({ itemId, batchId, reviewedBy: 'nick' });
    }
    return { runId, itemId, sku, typeProposalId, fieldProposalId, fieldDecisionId };
  }

  it('agent type evaluation leaves human dependents and durable review untouched without claiming refresh authority', () => {
    const fixture = createReviewFixture();
    const input = { workspaceId: wsId, productSku: fixture.sku, runId: fixture.runId,
      sourceKind: 'onboarding', onboardingItemId: fixture.itemId, reviewOrigin: 'agent_review',
      decisions: [{ proposalId: fixture.typeProposalId, decision: 'accepted', revisedValue: { categoryId: 'cat_food_cat', productTypeId: 'cat_food' }, reviewerId: 'opencode', actionToken: randomUUID(), expectedRevisionId: null }] } as const;
    const result = submitProposalDecisions({ ...input, decisions: [...input.decisions] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.refreshRequired).toBe(false);
    const retry = submitProposalDecisions({ ...input, decisions: [...input.decisions] });
    expect(retry.ok).toBe(true);
    if (result.ok && retry.ok) expect(retry.decisions[0].id).toBe(result.decisions[0].id);
    expect(getDb().query('SELECT status, is_stale FROM classification_proposals WHERE id = ?').get(fixture.fieldProposalId)).toEqual({ status: 'accepted', is_stale: 0 });
    expect(getDb().query('SELECT superseded_at FROM classification_proposal_decisions WHERE id = ?').get(fixture.fieldDecisionId)).toEqual({ superseded_at: null });
    expect(getReviewState(fixture.itemId)?.reviewInvalidatedAt).toBeNull();
    expect(getDb().query('SELECT COUNT(*) AS n FROM classification_refresh_queue WHERE expected_run_id = ?').get(fixture.runId)).toEqual({ n: 0 });
    const overwrite = submitProposalDecisions({ workspaceId: wsId, productSku: fixture.sku, runId: fixture.runId,
      sourceKind: 'onboarding', onboardingItemId: fixture.itemId, reviewOrigin: 'agent_review',
      decisions: [{ proposalId: fixture.fieldProposalId, decision: 'rejected', reviewerId: 'opencode' }] });
    expect(overwrite.ok).toBe(false);
    if (!overwrite.ok) expect(overwrite.code).toBe('decision_conflict');
    const confirmation = submitProposalDecisions({ workspaceId: wsId, productSku: fixture.sku, runId: fixture.runId,
      sourceKind: 'onboarding', onboardingItemId: fixture.itemId,
      decisions: [{ proposalId: fixture.typeProposalId, decision: 'accepted', reviewerId: 'nick', revisedValue: { categoryId: 'cat_food_cat', productTypeId: 'cat_food' },
        expectedRevisionId: result.ok ? result.decisions[0].id : null }] });
    expect(confirmation.ok).toBe(true);
    if (confirmation.ok) expect(confirmation.refreshRequired).toBe(true);
    expect(getDb().query('SELECT status, is_stale FROM classification_proposals WHERE id = ?').get(fixture.fieldProposalId)).toEqual({ status: 'stale', is_stale: 1 });
    expect(getReviewState(fixture.itemId)?.reviewInvalidatedAt).not.toBeNull();
    expect(getDb().query('SELECT COUNT(*) AS n FROM classification_refresh_queue WHERE expected_run_id = ?').get(fixture.runId)).toEqual({ n: 1 });
  });

  it('rejects target-only field injection before writing any revision or history', () => {
    const fixture = createReviewFixture();
    const beforeHistory = getDb().query('SELECT COUNT(*) AS n FROM classification_history_events WHERE run_id = ?').get(fixture.runId);
    const result = submitProposalDecisions({ workspaceId: wsId, productSku: fixture.sku, runId: fixture.runId,
      sourceKind: 'onboarding', onboardingItemId: fixture.itemId,
      decisions: [{ proposalId: fixture.fieldProposalId, decision: 'accepted', revisedTargetId: 'invented', reviewerId: 'nick' }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_decisions');
    expect(getDb().query('SELECT COUNT(*) AS n FROM classification_proposal_decisions WHERE proposal_id = ?').get(fixture.fieldProposalId)).toEqual({ n: 1 });
    expect(getDb().query('SELECT COUNT(*) AS n FROM classification_history_events WHERE run_id = ?').get(fixture.runId)).toEqual(beforeHistory);
  });

  it('returns a review conflict for corrupt item provenance without saving a decision', () => {
    const fixture = createReviewFixture();
    getDb().run('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?', ['{invalid', fixture.itemId]);
    const result = submitProposalDecisions({ workspaceId: wsId, productSku: fixture.sku, runId: fixture.runId,
      sourceKind: 'onboarding', onboardingItemId: fixture.itemId,
      decisions: [{ proposalId: fixture.typeProposalId, decision: 'accepted', reviewerId: 'nick' }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('decision_conflict');
    expect(getDb().query('SELECT COUNT(*) AS n FROM classification_proposal_decisions WHERE proposal_id = ?').get(fixture.typeProposalId)).toEqual({ n: 0 });
  });

  it('rolls back a mixed request that accepts a dependent invalidated by its earlier type correction', () => {
    const fixture = createReviewFixture(false);
    const result = submitProposalDecisions({ workspaceId: wsId, productSku: fixture.sku, runId: fixture.runId,
      sourceKind: 'onboarding', onboardingItemId: fixture.itemId, decisions: [
        { proposalId: fixture.typeProposalId, decision: 'accepted', revisedValue: { categoryId: 'cat_food_cat', productTypeId: 'cat_food' }, reviewerId: 'nick', expectedRevisionId: null },
        { proposalId: fixture.fieldProposalId, decision: 'accepted', reviewerId: 'nick', expectedRevisionId: null },
      ] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('decision_conflict');
    expect(getDb().query('SELECT status, is_stale FROM classification_proposals WHERE id = ?').get(fixture.fieldProposalId)).toEqual({ status: 'pending', is_stale: 0 });
    expect(getDb().query('SELECT COUNT(*) AS n FROM classification_proposal_decisions WHERE proposal_id IN (?, ?)').get(fixture.typeProposalId, fixture.fieldProposalId)).toEqual({ n: 0 });
    expect(getDb().query('SELECT COUNT(*) AS n FROM classification_refresh_queue WHERE expected_run_id = ?').get(fixture.runId)).toEqual({ n: 0 });
  });
});
