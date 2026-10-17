import { describe, it, expect, beforeEach } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { insertWorkspace } from '../../db/repositories/workspace-repo';
import { createRun as createRepositoryRun, completeRun, getAcceptedProposals, getLiveDecisionsByRun, getProposalsByRun, insertDecisionRow, supersedeDecisionsForProposals } from '../../db/repositories/classification-run-repo';
import { getDb } from '../../db/connection';
import { submitProposalDecisions } from '../../classification/proposal-review-service';
import { validateCatalogReviewCompletionGate } from '../../classification/review-completion-gate';
import { upsertConfigSnapshot } from '../../db/repositories/classification-config-repo';
import { buildRuntimeSnapshot, persistRuntimeSnapshot, getRuntimeSnapshotByHash } from '../../classification/runtime-snapshot';
import { generateCandidate, type BayStateSeed } from '../../classification/config-generator';
import type { ClassificationConfigBundleV2 } from '../../shared/schemas/classification';
import type { CatalogEvidence } from '../../classification/catalog-evidence';

function loadClassificationConfigFixture(): ClassificationConfigBundleV2 {
  const seed: BayStateSeed = {
    name: 'Review protocol fixture', revision: 'review-v1', createdAt: '2026-08-01T12:00:00.000Z',
    categories: [
      { id: 'dog-food', name: 'Dog Food', description: null },
      { id: 'cat-food', name: 'Cat Food', description: null },
      { id: 'bird-food', name: 'Bird Food', description: null },
    ],
    productTypes: [
      { id: 'dry-dog-food', name: 'Dry Dog Food', description: null, categoryId: 'dog-food', websiteValues: { category: 'Dog Food', productType: 'Dry Dog Food' } },
      { id: 'dog-food-dry', name: 'Dog Kibble', description: null, categoryId: 'dog-food', websiteValues: { category: 'Dog Food', productType: 'Dog Kibble' } },
      { id: 'cat-food-wet', name: 'Wet Cat Food', description: null, categoryId: 'cat-food', websiteValues: { category: 'Cat Food', productType: 'Wet Cat Food' } },
      { id: 'bird-food', name: 'Bird Food', description: null, categoryId: 'bird-food', websiteValues: { category: 'Bird Food', productType: 'Bird Food' } },
    ],
    attributes: [
      { id: 'flavor', name: 'Flavor', description: null, valueMode: 'controlled', canonicalUnit: null,
        allowedValues: ['Chicken', 'Beef', 'Salmon'], valueAliases: [], visualEvidenceEligibility: 'eligible',
        isClaim: false, isCompositionAttribute: false, group: 'Food', isUniversal: false },
    ],
    profileTemplates: [{ id: 'food-profile', name: 'Food', productTypeIds: ['dry-dog-food'],
      attributes: [{ attributeId: 'flavor', required: true, cardinality: 'single' }] }],
    mappings: [{ id: 'flavor-mapping', attributeId: 'flavor', catalogField: 'ProductField23',
      serialization: { kind: 'scalar', prefix: '', suffix: '' } }],
    curationTargets: [
      { id: 'primary-product-type', kind: 'product_type', label: 'Product Classification', enabled: true, selectionMode: 'single', attributeId: null, catalogField: null, optionSource: 'configured', required: false, mandatory: false, sortOrder: 0 },
      { id: 'flavor-target', kind: 'product_field', label: 'Flavor', enabled: true, selectionMode: 'single', attributeId: 'flavor', catalogField: 'ProductField23', optionSource: 'configured', required: false, mandatory: false, sortOrder: 1 },
    ],
    brands: [], guidance: [],
    modelPolicy: { defaultProvider: 'ollama', defaultModel: 'fixture-model', providerLocalities: { ollama: 'local' },
      stageOverrides: {}, imageDataSharing: 'local_only', textDataSharing: 'local_only',
      mlFeatures: {
        productionRetrieval: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        pageReranking: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        confidenceCalibration: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
        productionEmbeddings: { state: 'disabled', qualificationReceiptDigest: null, activatedBy: null, activatedAt: null },
      } },
    dataSharing: { imagePolicy: 'local_only', textPolicy: 'local_only', sensitiveDataFiltering: true, retentionDays: 90 },
  };
  const evidence: CatalogEvidence = { schemaVersion: 1, sourceTreeHash: '0'.repeat(64), productFileCount: 0,
    parseFailureCount: 0, parseFailures: [], fieldRegistry: { entryCount: 1, xmlFields: ['ProductField23'] },
    fields: [], pages: [] };
  return generateCandidate(seed, evidence).bundle;
}

const workspaceId = 'ws-catalog-class-db-test';

let workspacePath: string;

// Capture one coherent configuration before creating the run. Historical
// no-capture cases explicitly use createRepositoryRun instead of this fixture.
function createRun(...args: Parameters<typeof createRepositoryRun>) {
  const [workspaceId, sku, , snapshotHash, options] = args;
  if (snapshotHash && getRuntimeSnapshotByHash(workspaceId, snapshotHash)) {
    return createRepositoryRun(...args);
  }
  const bundle = loadClassificationConfigFixture();
  const ref = upsertConfigSnapshot(workspaceId, bundle);
  const snapshot = buildRuntimeSnapshot({ workspaceId, workspacePath, productSku: sku,
    authority: { kind: 'v2', bundle },
    configSnapshotRef: { id: ref.id, hash: ref.hash, sourceCommit: null, createdAt: new Date().toISOString() },
    sourceProductHash: options?.sourceProductHash ?? null });
  const persisted = persistRuntimeSnapshot(snapshot);
  return createRepositoryRun(workspaceId, sku, persisted.id, persisted.hash, options);
}

describe('proposal-review-service (catalog product)', () => {
  beforeEach(() => {
    // Fresh in-memory database before each test
    workspacePath = path.join(os.tmpdir(), `catalog-class-db-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(path.join(workspacePath, '.baystate-cms'), { recursive: true });
    const dbPath = path.join(workspacePath, '.baystate-cms', 'app.db');
    initDb(dbPath);
    runMigrations();
    const now = new Date().toISOString();
    insertWorkspace({ id: workspaceId, name: 'Review fixture', workspacePath, gitPath: '',
      createdAt: now, updatedAt: now, bootstrapStatus: 'complete', baselineCommit: null });
  });

  it('rejects decisions for a non-existent run', () => {
    const result = submitProposalDecisions({
      workspaceId,
      productSku: 'SKU001',
      runId: 'nonexistent',
      sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'p1', decision: 'accepted' }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('run_not_found');
  });

  it('rejects decisions for a running run', () => {
    const run = createRun(workspaceId, 'SKU001', null, null, {
      sourceKind: 'catalog_product',
      sourceProductHash: 'abc123',
    });

    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'field_assignment', 'flavor', '"Beef"', 0.8, 'pending', ?)`,
      ['proposal-1', run.id, 'SKU001', new Date().toISOString()],
    );

    const result = submitProposalDecisions({
      workspaceId,
      productSku: 'SKU001',
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'proposal-1', decision: 'accepted' }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('run_not_completed');
  });

  it('accepts valid decisions for a completed catalog run', () => {
    const run = createRun(workspaceId, 'SKU001', null, null, {
      sourceKind: 'catalog_product',
      sourceProductHash: 'abc123',
    });

    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'field_assignment', 'flavor', '"Beef"', 0.9, 'pending', ?)`,
      ['proposal-accept', run.id, 'SKU001', new Date().toISOString()],
    );

    completeRun(run.id, 'completed');

    const result = submitProposalDecisions({
      workspaceId,
      productSku: 'SKU001',
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'proposal-accept', decision: 'accepted' }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decisions).toHaveLength(1);
      expect(result.decisions[0].decision).toBe('accepted');
    }
  });

  it('hydrates evidence citations on live decisions and role-split ids on proposals (issue #17 H/I)', () => {
    const run = createRun(workspaceId, 'SKU-CITE', null, null, {
      sourceKind: 'catalog_product',
      sourceProductHash: 'cite-hash',
    });
    const db = getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO classification_evidence
       (id, run_id, product_sku, stage_name, source, reliability, attribute_id, value_json, created_at)
       VALUES (?, ?, ?, 'evidence_extraction', 'official_product_page', 'high', 'flavor', '"Chicken"', ?)`,
      ['ev-cite-1', run.id, 'SKU-CITE', now],
    );
    db.run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status,
        evidence_ids_json, supporting_evidence_ids_json, contradicting_evidence_ids_json, created_at)
       VALUES (?, ?, ?, 'field_assignment', 'flavor', '"Chicken"', 0.9, 'pending', ?, ?, ?, ?)`,
      ['proposal-cite', run.id, 'SKU-CITE',
        JSON.stringify(['ev-cite-1', 'ev-cite-x']),
        JSON.stringify(['ev-cite-1']),
        JSON.stringify(['ev-cite-x']),
        now],
    );
    db.run(
      'INSERT OR IGNORE INTO classification_proposal_evidence (proposal_id, evidence_id, relation) VALUES (?, ?, ?)',
      ['proposal-cite', 'ev-cite-1', 'supporting'],
    );
    // Roles are authoritative from the relation join (issue #17 pass 5b): the
    // union member is persisted with its contradicting relation. The evidence
    // row must exist for the FK join.
    db.run(
      `INSERT OR IGNORE INTO classification_evidence
       (id, run_id, product_sku, stage_name, source, reliability, attribute_id, source_field, snippet, value_json, metadata_json, created_at)
       VALUES (?, ?, ?, 'evidence_extraction', 'official_product_page', 'high', 'flavor', 'flavor', NULL, '"Beef"', '{}', ?)`,
      ['ev-cite-x', run.id, 'SKU-CITE', now],
    );
    db.run(
      'INSERT OR IGNORE INTO classification_proposal_evidence (proposal_id, evidence_id, relation) VALUES (?, ?, ?)',
      ['proposal-cite', 'ev-cite-x', 'contradicting'],
    );
    completeRun(run.id, 'completed');

    const result = submitProposalDecisions({
      workspaceId,
      productSku: 'SKU-CITE',
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [{
        proposalId: 'proposal-cite',
        decision: 'accepted',
        evidenceIds: ['ev-cite-1'],
        actionToken: 'cite-token-1',
        expectedRevisionId: null,
      }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.decisions[0].evidenceIds).toEqual(['ev-cite-1']);

    // Live decisions hydrate citations from the join table.
    const live = getLiveDecisionsByRun(run.id);
    expect(live).toHaveLength(1);
    expect(live[0].evidenceIds).toEqual(['ev-cite-1']);

    // Proposals hydrate the authoritative role split.
    const proposals = getProposalsByRun(run.id);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].supportingEvidenceIds).toEqual(['ev-cite-1']);
    expect(proposals[0].contradictingEvidenceIds).toEqual(['ev-cite-x']);
  });


  it('rejects workspace mismatch', () => {
    const run = createRun(workspaceId, 'SKU001', null, null, {
      sourceKind: 'catalog_product',
      sourceProductHash: 'abc123',
    });

    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'field_assignment', 'flavor', '"Beef"', 0.8, 'pending', ?)`,
      ['proposal-ws', run.id, 'SKU001', new Date().toISOString()],
    );

    completeRun(run.id, 'completed');

    const result = submitProposalDecisions({
      workspaceId: 'wrong-ws',
      productSku: 'SKU001',
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'proposal-ws', decision: 'accepted' }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('workspace_mismatch');
  });

  it('rejects source kind mismatch', () => {
    const run = createRun(workspaceId, 'SKU001', null, null, {
      sourceKind: 'onboarding',
    });

    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'field_assignment', 'flavor', '"Beef"', 0.8, 'pending', ?)`,
      ['proposal-sk', run.id, 'SKU001', new Date().toISOString()],
    );

    completeRun(run.id, 'completed');

    const result = submitProposalDecisions({
      workspaceId,
      productSku: 'SKU001',
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'proposal-sk', decision: 'accepted' }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('source_mismatch');
  });

  it('keeps the proposal prediction immutable when a revised value is submitted', () => {
    const run = createRun(workspaceId, 'SKU001', null, null, {
      sourceKind: 'catalog_product',
      sourceProductHash: 'abc123',
    });

    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'field_assignment', 'flavor', '"Beef"', 0.9, 'pending', ?)`,
      ['prop-immutable', run.id, 'SKU001', new Date().toISOString()],
    );

    completeRun(run.id, 'completed');

    const result = submitProposalDecisions({
      workspaceId,
      productSku: 'SKU001',
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-immutable', decision: 'accepted', revisedValue: 'Chicken' }],
    });

    expect(result.ok).toBe(true);

    // Prediction is byte-identical; the correction lives on the decision row.
    const propRow = getDb().query(
      'SELECT proposed_value_json, target_id, status FROM classification_proposals WHERE id = ?',
    ).get('prop-immutable') as { proposed_value_json: string; target_id: string | null; status: string };
    expect(propRow.proposed_value_json).toBe('"Beef"');
    expect(propRow.target_id).toBe('flavor');
    expect(propRow.status).toBe('accepted');

    const decRow = getDb().query(
      'SELECT revised_value_json, revised_target_id FROM classification_proposal_decisions WHERE proposal_id = ?',
    ).get('prop-immutable') as { revised_value_json: string | null; revised_target_id: string | null };
    expect(decRow.revised_value_json).toBe('"Chicken"');
    expect(decRow.revised_target_id).toBeNull();
  });


  it('is idempotent for exact retries', () => {
    const run = createRun(workspaceId, 'SKU001', null, null, {
      sourceKind: 'catalog_product',
      sourceProductHash: 'abc123',
    });

    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'field_assignment', 'flavor', '"Chicken"', 0.9, 'pending', ?)`,
      ['prop-idem', run.id, 'SKU001', new Date().toISOString()],
    );

    completeRun(run.id, 'completed');

    const payload = {
      workspaceId,
      productSku: 'SKU001',
      runId: run.id,
      sourceKind: 'catalog_product' as const,
      decisions: [{ proposalId: 'prop-idem', decision: 'accepted' as const, revisedValue: 'Chicken' }],
    };
    const first = submitProposalDecisions(payload);
    const second = submitProposalDecisions(payload);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      // Exact retry returns the same decision, not a new row.
      expect(second.decisions[0].id).toBe(first.decisions[0].id);
    }
    const count = getDb().query(
      'SELECT COUNT(*) as c FROM classification_proposal_decisions WHERE proposal_id = ?',
    ).get('prop-idem') as { c: number };
    expect(count.c).toBe(1);
    const history = getDb().query(
      `SELECT COUNT(*) AS c FROM classification_history_events
       WHERE product_sku = 'SKU001' AND event_type = 'decisions_submitted'`,
    ).get() as { c: number };
    expect(history.c).toBe(1);
    const linked = getDb().query(
      `SELECT run_id, proposal_id, decision_id FROM classification_history_events
       WHERE event_type = 'proposal_decision'`,
    ).get() as { run_id: string; proposal_id: string; decision_id: string };
    expect(linked).toEqual({
      run_id: run.id,
      proposal_id: 'prop-idem',
      decision_id: first.ok ? first.decisions[0].id : '',
    });
    const summary = getDb().query(
      `SELECT run_id FROM classification_history_events
       WHERE event_type = 'decisions_submitted'`,
    ).get() as { run_id: string };
    expect(summary.run_id).toBe(run.id);
  });

  it('rolls back decisions and proposal status when audit insertion fails', () => {
    const run = createRun(workspaceId, 'SKU-AUDIT-ROLLBACK', null, null, {
      sourceKind: 'catalog_product',
      sourceProductHash: 'audit-source',
    });
    getDb().run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'field_assignment', 'flavor', '"Beef"', 0.9, 'pending', ?)`,
      ['prop-audit-rollback', run.id, 'SKU-AUDIT-ROLLBACK', new Date().toISOString()],
    );
    completeRun(run.id, 'completed');
    getDb().exec(`CREATE TRIGGER reject_decision_audit
      BEFORE INSERT ON classification_history_events
      BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);

    expect(() => submitProposalDecisions({
      workspaceId,
      productSku: 'SKU-AUDIT-ROLLBACK',
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [{
        proposalId: 'prop-audit-rollback',
        decision: 'accepted',
        actionToken: 'audit-rollback-token',
        expectedRevisionId: null,
      }],
    })).toThrow('audit unavailable');

    const decisionCount = getDb().query(
      'SELECT COUNT(*) AS count FROM classification_proposal_decisions WHERE proposal_id = ?',
    ).get('prop-audit-rollback') as { count: number };
    expect(decisionCount.count).toBe(0);
    const proposal = getDb().query(
      'SELECT status FROM classification_proposals WHERE id = ?',
    ).get('prop-audit-rollback') as { status: string };
    expect(proposal.status).toBe('pending');
  });

  it('rejects mixed canonical and legacy aliases at the service boundary', () => {
    const run = createRun(workspaceId, 'SKU-ALIASES', null, null, {
      sourceKind: 'catalog_product',
      sourceProductHash: 'alias-source',
    });
    getDb().run(
      `INSERT INTO classification_proposals
       (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'field_assignment', 'flavor', '"Beef"', 0.9, 'pending', ?)`,
      ['prop-aliases', run.id, 'SKU-ALIASES', new Date().toISOString()],
    );
    completeRun(run.id, 'completed');

    const result = submitProposalDecisions({
      workspaceId,
      productSku: 'SKU-ALIASES',
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [{
        proposalId: 'prop-aliases',
        decision: 'accepted',
        expectedRevisionId: null,
        revisedFromId: 'legacy-id',
      }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_decisions');
  });

  it('chains revisions through revised_from_id and supersedes the prior live decision', () => {
    const run = createRun(workspaceId, 'SKU001', null, null, {
      sourceKind: 'catalog_product',
      sourceProductHash: 'abc123',
    });

    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'field_assignment', 'flavor', '"Chicken"', 0.9, 'pending', ?)`,
      ['prop-chain', run.id, 'SKU001', new Date().toISOString()],
    );

    completeRun(run.id, 'completed');

    const first = submitProposalDecisions({
      workspaceId,
      productSku: 'SKU001',
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-chain', decision: 'accepted', revisedValue: 'Chicken', actionToken: 'chain-a', expectedRevisionId: null }],
    });
    expect(first.ok).toBe(true);
    const firstId = first.ok ? first.decisions[0].id : '';

    const second = submitProposalDecisions({
      workspaceId,
      productSku: 'SKU001',
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-chain', decision: 'accepted', revisedValue: 'Salmon', actionToken: 'chain-b', expectedRevisionId: firstId }],
    });
    expect(second.ok).toBe(true);
    const secondId = second.ok ? second.decisions[0].id : '';

    const rows = getDb().query(
      `SELECT id, revised_from_id, superseded_at, revised_value_json
       FROM classification_proposal_decisions WHERE proposal_id = ?
       ORDER BY created_at ASC, rowid ASC`,
    ).all('prop-chain') as Array<{ id: string; revised_from_id: string | null; superseded_at: string | null; revised_value_json: string | null }>;

    expect(rows).toHaveLength(2);
    expect(rows[1].id).toBe(secondId);
    expect(rows[1].revised_from_id).toBe(firstId);
    expect(rows[0].superseded_at).toBeTruthy();
    expect(rows[1].superseded_at).toBeNull();

    // Effective value surfaces on accepted proposals; the prediction stays original.
    const accepted = getAcceptedProposals('SKU001', run.id);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].proposedValue).toBe('Chicken');
    expect(accepted[0].revisedValue).toBe('Salmon');
    expect(accepted[0].hasRevisedValue).toBe(true);
    expect(accepted[0].currentDecisionId).toBe(secondId);
  });

  it('does not let a delayed retry supersede a newer decision', () => {
    const run = createRun(workspaceId, 'SKU001', null, null, { sourceKind: 'catalog_product' });
    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES ('prop-delayed', ?, 'SKU001', 'field_assignment', 'flavor', '"Beef"', 0.9, 'pending', ?)`,
      [run.id, new Date().toISOString()],
    );
    completeRun(run.id, 'completed');

    const actionA = { proposalId: 'prop-delayed', decision: 'accepted' as const, revisedValue: 'Chicken', actionToken: 'delayed-a', expectedRevisionId: null };
    const first = submitProposalDecisions({ workspaceId, productSku: 'SKU001', runId: run.id, sourceKind: 'catalog_product', decisions: [actionA] });
    expect(first.ok).toBe(true);
    const firstId = first.ok ? first.decisions[0].id : '';
    const second = submitProposalDecisions({
      workspaceId,
      productSku: 'SKU001',
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-delayed', decision: 'accepted', revisedValue: 'Salmon', actionToken: 'delayed-b', expectedRevisionId: firstId }],
    });
    expect(second.ok).toBe(true);
    const secondId = second.ok ? second.decisions[0].id : '';

    const retry = submitProposalDecisions({ workspaceId, productSku: 'SKU001', runId: run.id, sourceKind: 'catalog_product', decisions: [actionA] });
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.decisions[0].id).toBe(firstId);

    const accepted = getAcceptedProposals('SKU001', run.id);
    expect(accepted[0].revisedValue).toBe('Salmon');
    expect(accepted[0].currentDecisionId).toBe(secondId);
    const live = getDb().query(
      'SELECT id FROM classification_proposal_decisions WHERE proposal_id = ? AND superseded_at IS NULL',
    ).all('prop-delayed') as Array<{ id: string }>;
    expect(live).toEqual([{ id: secondId }]);
    const canonical = getLiveDecisionsByRun(run.id);
    expect(canonical).toHaveLength(1);
    expect(canonical[0].id).toBe(secondId);
    expect(canonical[0].revisedValue).toBe('Salmon');
  });

  it('preserves an explicit null correction as a deliberate clear', () => {
    const run = createRun(workspaceId, 'SKU001', null, null, { sourceKind: 'catalog_product' });
    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES ('prop-null', ?, 'SKU001', 'field_assignment', 'flavor', '"Beef"', 0.9, 'pending', ?)`,
      [run.id, new Date().toISOString()],
    );
    completeRun(run.id, 'completed');
    const result = submitProposalDecisions({
      workspaceId,
      productSku: 'SKU001',
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-null', decision: 'accepted', revisedValue: null, actionToken: 'clear-null', expectedRevisionId: null }],
    });
    expect(result.ok).toBe(true);
    const accepted = getAcceptedProposals('SKU001', run.id);
    expect(accepted[0].hasRevisedValue).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(accepted[0], 'revisedValue')).toBe(true);
    expect(accepted[0].revisedValue).toBeNull();
    expect(accepted[0].proposedValue).toBe('Beef');
  });

  it('preserves an explicit null target correction as a deliberate clear', () => {
    const run = createRun(workspaceId, 'SKU001', null, null, { sourceKind: 'catalog_product' });
    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES ('prop-target-null', ?, 'SKU001', 'field_assignment', 'flavor', '"Beef"', 0.9, 'pending', ?)`,
      [run.id, new Date().toISOString()],
    );
    completeRun(run.id, 'completed');
    const result = submitProposalDecisions({
      workspaceId,
      productSku: 'SKU001',
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [{
        proposalId: 'prop-target-null',
        decision: 'accepted',
        revisedTargetId: null,
        actionToken: 'clear-target-null',
        expectedRevisionId: null,
      }],
    });
    expect(result.ok).toBe(true);

    const decRow = getDb().query(
      'SELECT revised_target_id, has_revised_target FROM classification_proposal_decisions WHERE proposal_id = ?',
    ).get('prop-target-null') as { revised_target_id: string | null; has_revised_target: number };
    expect(decRow.revised_target_id).toBeNull();
    expect(Number(decRow.has_revised_target)).toBe(1);

    const accepted = getAcceptedProposals('SKU001', run.id);
    expect(accepted[0].hasRevisedTargetId).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(accepted[0], 'revisedTargetId')).toBe(true);
    expect(accepted[0].revisedTargetId).toBeNull();
    expect(accepted[0].targetId).toBe('flavor');
  });

  it('rejects a crossed decision id and action token collision', () => {
    const run = createRun(workspaceId, 'SKU001', null, null, { sourceKind: 'catalog_product' });
    for (const id of ['prop-cross-a', 'prop-cross-b']) {
      getDb().run(
        `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
         VALUES (?, ?, 'SKU001', 'field_assignment', 'flavor', '"Beef"', 0.8, 'pending', ?)`,
        [id, run.id, new Date().toISOString()],
      );
    }
    insertDecisionRow(getDb(), {
      id: 'id-a',
      proposalId: 'prop-cross-a',
      decision: 'accepted',
      revisedValue: 'Chicken',
      actionToken: 'token-a',
      expectedRevisionId: null,
    });
    insertDecisionRow(getDb(), {
      id: 'id-b',
      proposalId: 'prop-cross-b',
      decision: 'accepted',
      revisedValue: 'Beef',
      actionToken: 'token-b',
      expectedRevisionId: null,
    });

    expect(() => insertDecisionRow(getDb(), {
      id: 'id-b',
      proposalId: 'prop-cross-a',
      decision: 'accepted',
      revisedValue: 'Chicken',
      actionToken: 'token-a',
      expectedRevisionId: null,
    })).toThrow(/does not match the action token/i);
  });

  it('honors a client-supplied decision id when unused', () => {
    const run = createRun(workspaceId, 'SKU001', null, null, { sourceKind: 'catalog_product' });
    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES ('prop-client-id', ?, 'SKU001', 'field_assignment', 'flavor', '"Beef"', 0.8, 'pending', ?)`,
      [run.id, new Date().toISOString()],
    );
    completeRun(run.id, 'completed');
    const result = submitProposalDecisions({
      workspaceId,
      productSku: 'SKU001',
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [{
        proposalId: 'prop-client-id',
        decision: 'accepted',
        // proposal-review-service path doesn't expose id; exercise insertDecisionRow directly below
      }],
    });
    expect(result.ok).toBe(true);

    const custom = insertDecisionRow(getDb(), {
      id: 'client-chosen-id',
      proposalId: 'prop-client-id',
      decision: 'accepted',
      revisedValue: 'Salmon',
      actionToken: 'client-id-token',
      expectedRevisionId: result.ok ? result.decisions[0].id : null,
    });
    expect(custom.inserted).toBe(true);
    expect(custom.decisionId).toBe('client-chosen-id');
    expect(custom.decision.id).toBe('client-chosen-id');
  });

  it('rejects a client decision id collision instead of treating it as a retry', () => {
    const run = createRun(workspaceId, 'SKU001', null, null, { sourceKind: 'catalog_product' });
    for (const id of ['prop-id-a', 'prop-id-b']) {
      getDb().run(
        `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
         VALUES (?, ?, 'SKU001', 'field_assignment', 'flavor', '"Beef"', 0.8, 'pending', ?)`,
        [id, run.id, new Date().toISOString()],
      );
    }
    insertDecisionRow(getDb(), {
      id: 'shared-decision-id',
      proposalId: 'prop-id-a',
      decision: 'accepted',
      actionToken: 'id-action-a',
      expectedRevisionId: null,
    });
    expect(() => insertDecisionRow(getDb(), {
      id: 'shared-decision-id',
      proposalId: 'prop-id-b',
      decision: 'accepted',
      actionToken: 'id-action-b',
      expectedRevisionId: null,
    })).toThrow(/decision id/i);
    const second = getDb().query(
      "SELECT status FROM classification_proposals WHERE id = 'prop-id-b'",
    ).get() as { status: string };
    expect(second.status).toBe('pending');
  });

  it('rolls back the whole batch when a decision insert fails mid-transaction', () => {
    const run = createRun(workspaceId, 'SKU001', null, null, {
      sourceKind: 'catalog_product',
      sourceProductHash: 'abc123',
    });

    for (const id of ['prop-a', 'prop-b']) {
      getDb().run(
        `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
         VALUES (?, ?, ?, 'field_assignment', 'flavor', '"Beef"', 0.8, 'pending', ?)`,
        [id, run.id, 'SKU001', new Date().toISOString()],
      );
    }

    completeRun(run.id, 'completed');

    // Invalid values are rejected before writes. Exercise an actual second
    // INSERT failure to prove the transaction still rolls the first back.
    getDb().exec(`CREATE TRIGGER reject_second_review BEFORE INSERT ON classification_proposal_decisions
      WHEN NEW.proposal_id = 'prop-b' BEGIN SELECT RAISE(ABORT, 'fixture second review insert failed'); END`);

    expect(() =>
      submitProposalDecisions({
        workspaceId,
        productSku: 'SKU001',
        runId: run.id,
        sourceKind: 'catalog_product',
        decisions: [
          { proposalId: 'prop-a', decision: 'accepted' },
          { proposalId: 'prop-b', decision: 'accepted' },
        ],
      }),
    ).toThrow();

    const count = getDb().query(
      "SELECT COUNT(*) as c FROM classification_proposal_decisions WHERE proposal_id IN ('prop-a', 'prop-b')",
    ).get() as { c: number };
    expect(count.c).toBe(0);

    const statuses = getDb().query(
      "SELECT status FROM classification_proposals WHERE id IN ('prop-a', 'prop-b')",
    ).all() as Array<{ status: string }>;
    expect(statuses.every(s => s.status === 'pending')).toBe(true);
  });

  it('rejects new corrections on historical runs without a frozen runtime snapshot', () => {
    const run = createRepositoryRun(workspaceId, 'LEGACY-CORRECTION', null, null, { sourceKind: 'catalog_product' });
    getDb().run(`INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
      VALUES ('legacy-field', ?, 'LEGACY-CORRECTION', 'field_assignment', 'flavor', '"Beef"', 0.8, 'pending', datetime('now'))`, [run.id]);
    completeRun(run.id, 'completed');
    const result = submitProposalDecisions({ workspaceId, productSku: 'LEGACY-CORRECTION', runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'legacy-field', decision: 'accepted', revisedValue: 'Chicken' }] });
    expect(result.ok).toBe(false);
    expect(getLiveDecisionsByRun(run.id)).toHaveLength(0);
  });


  it('keeps historical proposals readable and rejectable/deferable without granting acceptance authority', () => {
    const sku = 'LEGACY-OUTPUT-AUTHORITY';
    const run = createRepositoryRun(workspaceId, sku, null, null, { sourceKind: 'catalog_product' });
    for (const id of ['legacy-accept', 'legacy-reject', 'legacy-defer']) {
      getDb().run(`INSERT INTO classification_proposals
        (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
        VALUES (?, ?, ?, 'field_assignment', 'unknown-historical-attribute', '"Beef"', 0.8, 'pending', datetime('now'))`, [id, run.id, sku]);
    }
    completeRun(run.id, 'completed');
    const refused = submitProposalDecisions({ workspaceId, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'legacy-accept', decision: 'accepted' }] });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe('configuration_gap');
    expect(getLiveDecisionsByRun(run.id)).toEqual([]);
    expect(getProposalsByRun(run.id)).toHaveLength(3);
    const historicalReview = submitProposalDecisions({ workspaceId, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'legacy-reject', decision: 'rejected' }, { proposalId: 'legacy-defer', decision: 'deferred' }] });
    expect(historicalReview.ok).toBe(true);
    expect(getLiveDecisionsByRun(run.id).map(decision => decision.decision).sort()).toEqual(['deferred', 'rejected']);
    expect(getAcceptedProposals(sku, run.id)).toEqual([]);
  });


  it('does not treat a bare config snapshot as captured runtime output authority', () => {
    const sku = 'CONFIG-ONLY-AUTHORITY';
    const ref = upsertConfigSnapshot(workspaceId, loadClassificationConfigFixture());
    const run = createRepositoryRun(workspaceId, sku, ref.id, ref.hash, { sourceKind: 'catalog_product' });
    getDb().run(`INSERT INTO classification_proposals
      (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
      VALUES ('config-only', ?, ?, 'field_assignment', 'flavor', '"Chicken"', 0.9, 'pending', datetime('now'))`, [run.id, sku]);
    completeRun(run.id, 'completed');
    const result = submitProposalDecisions({ workspaceId, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'config-only', decision: 'accepted' }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('configuration_gap');
    expect(getLiveDecisionsByRun(run.id)).toEqual([]);
    expect(getProposalsByRun(run.id)[0].status).toBe('pending');
  });

  it('atomically refuses unknown original and revised field authority, including clears', () => {
    const sku = 'UNKNOWN-OUTPUT-AUTHORITY';
    const run = createRun(workspaceId, sku, null, null, { sourceKind: 'catalog_product' });
    for (const [id, target] of [['known-first', 'flavor'], ['unknown-original', 'not-configured'], ['known-revised', 'flavor']]) {
      getDb().run(`INSERT INTO classification_proposals
        (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
        VALUES (?, ?, ?, 'field_assignment', ?, '"Beef"', 0.8, 'pending', datetime('now'))`, [id, run.id, sku, target]);
    }
    completeRun(run.id, 'completed');
    const invalidDecisions = [
      [{ proposalId: 'unknown-original', decision: 'accepted' as const }, 'protected_target_refused'],
      [{ proposalId: 'unknown-original', decision: 'accepted' as const, revisedTargetId: 'flavor', revisedValue: 'Chicken' }, 'protected_target_refused'],
      [{ proposalId: 'unknown-original', decision: 'accepted' as const, revisedValue: null }, 'protected_target_refused'],
      [{ proposalId: 'known-revised', decision: 'accepted' as const, revisedTargetId: 'not-configured', revisedValue: 'Chicken' }, 'protected_target_refused'],
      [{ proposalId: 'known-revised', decision: 'accepted' as const, revisedTargetId: 'not-configured', revisedValue: null }, 'protected_target_refused'],
      [{ proposalId: 'known-revised', decision: 'accepted' as const, revisedTargetId: 'ProductField23', revisedValue: 'Chicken' }, 'configuration_gap'],
    ] as const;
    for (const [decision, expectedCode] of invalidDecisions) {
      const result = submitProposalDecisions({ workspaceId, productSku: sku, runId: run.id, sourceKind: 'catalog_product',
        decisions: [{ proposalId: 'known-first', decision: 'accepted' }, decision] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(expectedCode);
      expect(getLiveDecisionsByRun(run.id)).toEqual([]);
      expect(getAcceptedProposals(sku, run.id)).toEqual([]);
      expect(getProposalsByRun(run.id).every(proposal => proposal.status === 'pending')).toBe(true);
    }
  });

  it('superseded decisions no longer satisfy the catalog review gate', () => {
    const run = createRun(workspaceId, 'SKU001', null, null, {
      sourceKind: 'catalog_product',
      sourceProductHash: 'abc123',
    });

    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'field_assignment', 'flavor', '"Beef"', 0.8, 'pending', ?)`,
      ['prop-gate', run.id, 'SKU001', new Date().toISOString()],
    );
    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'product_classification', 'dry-dog-food', '{"categoryId":"dog-food","productTypeId":"dry-dog-food"}', 0.9, 'pending', ?)`,
      ['prop-pair', run.id, 'SKU001', new Date().toISOString()],
    );

    completeRun(run.id, 'completed');

    const result = submitProposalDecisions({
      workspaceId,
      productSku: 'SKU001',
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [
        { proposalId: 'prop-pair', decision: 'accepted' },
        { proposalId: 'prop-gate', decision: 'accepted' },
      ],
    });
    expect(result.ok).toBe(true);

    // Gate passes while the decision is live.
    const gateBefore = validateCatalogReviewCompletionGate({ workspaceId, productSku: 'SKU001', runId: run.id });
    expect(gateBefore.ok).toBe(true);

    // Simulate the review-reset flow: decisions superseded, proposal pending.
    supersedeDecisionsForProposals(['prop-gate']);
    getDb().run('UPDATE classification_proposals SET status = ? WHERE id = ?', ['pending', 'prop-gate']);

    // Superseded decisions no longer satisfy the gate: the proposal is
    // pending again and must be re-reviewed before completion can proceed.
    const gateAfter = validateCatalogReviewCompletionGate({ workspaceId, productSku: 'SKU001', runId: run.id });
    expect(gateAfter.ok).toBe(false);
    if (!gateAfter.ok) expect(gateAfter.code).toBe('pending_proposals');

    // A new review action may intentionally reissue the same payload after reset.
    const rereview = submitProposalDecisions({
      workspaceId,
      productSku: 'SKU001',
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [{
        proposalId: 'prop-gate',
        decision: 'accepted',
        actionToken: 'post-reset-action',
        expectedRevisionId: null,
      }],
    });
    expect(rereview.ok).toBe(true);
    expect(validateCatalogReviewCompletionGate({ workspaceId, productSku: 'SKU001', runId: run.id }).ok).toBe(true);
    const historyCount = getDb().query(
      "SELECT COUNT(*) AS count FROM classification_proposal_decisions WHERE proposal_id = 'prop-gate'",
    ).get() as { count: number };
    expect(historyCount.count).toBe(2);
  });

  it('queues a dependent refresh when a Product Classification decision changes', () => {
    const run = createRun(workspaceId, 'SKU-TYPE-REFRESH', null, 'snap-hash', {
      sourceKind: 'catalog_product',
      sourceProductHash: 'abc123',
    });

    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'product_classification', 'dry-dog-food', '{"categoryId":"dog-food","productTypeId":"dry-dog-food"}', 0.8, 'pending', ?)`,
      ['prop-type', run.id, 'SKU-TYPE-REFRESH', new Date().toISOString()],
    );

    completeRun(run.id, 'completed');

    const result = submitProposalDecisions({
      workspaceId,
      productSku: 'SKU-TYPE-REFRESH',
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-type', decision: 'accepted', actionToken: 'type-accept-1' }],
    });
    expect(result.ok).toBe(true);

    const queued = getDb().query(
      `SELECT trigger_type, refresh_scope_json, status FROM classification_refresh_queue
       WHERE workspace_id = ? AND product_sku = ?`,
    ).all(workspaceId, 'SKU-TYPE-REFRESH') as Array<{ trigger_type: string; refresh_scope_json: string; status: string }>;
    expect(queued.length).toBeGreaterThanOrEqual(1);
    const row = queued.find(q => q.trigger_type === 'primary_product_type_change');
    expect(row).toBeDefined();
    expect(row!.status).toBe('queued');
    const scope = JSON.parse(row!.refresh_scope_json) as { runId: string };
    expect(scope.runId).toBe(run.id);

    // An exact action-token retry is an idempotent no-op (no new decision
    // inserted), so it must not stack a duplicate queued refresh.
    const retry = submitProposalDecisions({
      workspaceId,
      productSku: 'SKU-TYPE-REFRESH',
      runId: run.id,
      sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-type', decision: 'accepted', actionToken: 'type-accept-1', expectedRevisionId: null }],
    });
    expect(retry.ok).toBe(true);
    const queuedCount = getDb().query(
      `SELECT COUNT(*) AS count FROM classification_refresh_queue
       WHERE workspace_id = ? AND product_sku = ? AND trigger_type = 'primary_product_type_change' AND status = 'queued'`,
    ).get(workspaceId, 'SKU-TYPE-REFRESH') as { count: number };
    expect(queuedCount.count).toBe(1);
  });

  it('blocks catalog review completion until a Product Classification pair is reviewed', () => {
    const config = loadClassificationConfigFixture();
    const { id: snapId, hash: snapHash } = upsertConfigSnapshot(workspaceId, config);
    const runtime = buildRuntimeSnapshot({
      workspaceId,
      workspacePath,
      productSku: 'SKU-GATED',
      authority: { kind: 'v2', bundle: config },
      configSnapshotRef: { id: snapId, hash: snapHash, sourceCommit: null, createdAt: new Date().toISOString() },
      sourceProductHash: 'gated-hash',
    });
    persistRuntimeSnapshot(runtime);

    const run = createRun(workspaceId, 'SKU-GATED', null, runtime.snapshotHash, {
      sourceKind: 'catalog_product',
      sourceProductHash: 'gated-hash',
    });

    // A type-gated field assignment with a decision, but NO accepted type.
    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'field_assignment', 'flavor', '"Chicken"', 0.8, 'accepted', ?)`,
      ['prop-gated', run.id, 'SKU-GATED', new Date().toISOString()],
    );
    getDb().run(
      `INSERT INTO classification_proposal_decisions
       (id, proposal_id, decision, created_at, superseded_at)
       VALUES (?, ?, 'accepted', ?, NULL)`,
      ['dec-gated', 'prop-gated', new Date().toISOString()],
    );
    completeRun(run.id, 'completed');

    const gate = validateCatalogReviewCompletionGate({ workspaceId, productSku: 'SKU-GATED', runId: run.id });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe('pair_unresolved');

    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'primary_product_type', 'dry-dog-food', '{"productTypeId":"dry-dog-food"}', 0.9, 'pending', ?)`,
      ['prop-legacy-type', run.id, 'SKU-GATED', new Date().toISOString()],
    );
    const legacyDecision = submitProposalDecisions({
      workspaceId, productSku: 'SKU-GATED', runId: run.id, sourceKind: 'catalog_product',
      decisions: [{ proposalId: 'prop-legacy-type', decision: 'accepted' }],
    });
    expect(legacyDecision.ok).toBe(false);
    if (!legacyDecision.ok) {
      expect(legacyDecision.code).toBe('invalid_decisions');
      expect(legacyDecision.reason).toMatch(/history-only/);
    }
    expect(getProposalsByRun(run.id).find(proposal => proposal.id === 'prop-legacy-type')!.status).toBe('pending');

    getDb().run("UPDATE classification_proposals SET status = 'accepted' WHERE id = ?", ['prop-legacy-type']);
    getDb().run(
      `INSERT INTO classification_proposal_decisions
       (id, proposal_id, decision, revised_value_json, revised_target_id, created_at, superseded_at)
       VALUES (?, ?, 'accepted', '{"productTypeId":"dry-dog-food"}', 'dry-dog-food', ?, NULL)`,
      ['dec-legacy-type', 'prop-legacy-type', new Date().toISOString()],
    );
    expect(getProposalsByRun(run.id).find(proposal => proposal.id === 'prop-legacy-type')!.status).toBe('accepted');
    expect(getAcceptedProposals('SKU-GATED', run.id).some(proposal => proposal.id === 'prop-legacy-type')).toBe(false);

    // Only the canonical pair unblocks the gate; legacy type-only history
    // remains inspectable but cannot act as current classification authority.
    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, ?, 'product_classification', 'dry-dog-food', '{"categoryId":"dog-food","productTypeId":"dry-dog-food"}', 0.9, 'accepted', ?)`,
      ['prop-type-accepted', run.id, 'SKU-GATED', new Date().toISOString()],
    );
    getDb().run(
      `INSERT INTO classification_proposal_decisions
       (id, proposal_id, decision, revised_value_json, revised_target_id, created_at, superseded_at)
       VALUES (?, ?, 'accepted', '{"categoryId":"dog-food","productTypeId":"dry-dog-food"}', 'dry-dog-food', ?, NULL)`,
      ['dec-type-accepted', 'prop-type-accepted', new Date().toISOString()],
    );
    const gateAfter = validateCatalogReviewCompletionGate({ workspaceId, productSku: 'SKU-GATED', runId: run.id });
    expect(gateAfter.ok).toBe(true);
  });

  it('getAcceptedProposals requires a live accepted decision, never a spoofed status column', () => {
    const run = createRun(workspaceId, 'SKU-ACCEPTED', null, null, { sourceKind: 'catalog_product' });
    const now = new Date().toISOString();
    // Spoofed: status column says accepted but no decision row exists.
    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, 'SKU-ACCEPTED', 'field_assignment', 'flavor', '"Spoof"', 0.9, 'accepted', ?)`,
      ['prop-accepted-spoof', run.id, now],
    );
    // Deferred: live decision is deferred.
    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, 'SKU-ACCEPTED', 'field_assignment', 'flavor', '"Deferred"', 0.8, 'deferred', ?)`,
      ['prop-accepted-deferred', run.id, now],
    );
    getDb().run(
      `INSERT INTO classification_proposal_decisions
       (id, proposal_id, decision, decision_key, created_at)
       VALUES ('dec-accepted-deferred', 'prop-accepted-deferred', 'deferred', 'deferred-key', ?)`,
      [now],
    );
    // Genuine: status accepted AND a live accepted decision.
    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, 'SKU-ACCEPTED', 'field_assignment', 'flavor', '"Chicken"', 0.9, 'accepted', ?)`,
      ['prop-accepted-live', run.id, now],
    );
    getDb().run(
      `INSERT INTO classification_proposal_decisions
       (id, proposal_id, decision, decision_key, created_at)
       VALUES ('dec-accepted-live', 'prop-accepted-live', 'accepted', 'live-key', ?)`,
      [now],
    );
    completeRun(run.id, 'completed');

    const accepted = getAcceptedProposals('SKU-ACCEPTED', run.id);
    expect(accepted.map((p: any) => p.id)).toEqual(['prop-accepted-live']);
    expect(accepted[0].proposedValue).toBe('Chicken');
  });

  it('persists and roundtrips proposal derivation provenance (e.g. product_type_invariant)', () => {
    const run = createRun(workspaceId, 'SKU-INVARIANT', null, null, { sourceKind: 'catalog_product' });

    const now = new Date().toISOString();
    const derivation = {
      kind: 'product_type_invariant' as const,
      productTypeId: 'dog-food-dry',
      productTypeSource: 'reviewed' as const,
    };

    getDb().run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, target_id, proposed_value_json, confidence, derivation_json, status, created_at)
       VALUES (?, ?, 'SKU-INVARIANT', 'field_assignment', 'species', '"Dog"', 1.0, ?, 'pending', ?)`,
      ['prop-invariant-1', run.id, JSON.stringify(derivation), now],
    );

    const proposals = getProposalsByRun(run.id);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].id).toBe('prop-invariant-1');
    expect(proposals[0].targetId).toBe('species');
    expect(proposals[0].proposedValue).toBe('Dog');
    expect(proposals[0].confidence).toBe(1.0);
    expect(proposals[0].derivation).toEqual(derivation);
  });
});
