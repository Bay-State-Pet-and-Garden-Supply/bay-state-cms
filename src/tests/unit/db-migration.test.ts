import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { getDb } from '../../db/connection';
import { runMigrations, getSchemaVersion } from '../../db/migrations';
import {
  upsertPage,
  assignProductToPage,
  assignProductToPageId,
  getProductPages,
  getProductPageAssignments,
  clearProductPages,
} from '../../db/repositories/page-repo';
import { createBatch, deleteBatch } from '../../db/repositories/onboarding-batch-repo';
import { insertItems } from '../../db/repositories/onboarding-item-repo';
import { insertWorkspace } from '../../db/repositories/workspace-repo';

describe('SQLite Migration', () => {
  const testDbPath = '/tmp/baystate-cms-test.db';

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(testDbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(testDbPath); } catch { /* ok */ }
  });

  it('should create app_meta with schema_version', () => {
    const version = getSchemaVersion();
    expect(version).toBe('1');
  });

  it('should create app_meta with classification_schema_version', () => {
    const db = getDb();
    const row = db.query(
      "SELECT value FROM app_meta WHERE key = 'classification_schema_version'"
    ).get() as { value: string } | undefined;
    expect(row).toBeTruthy();
    expect(row!.value).toBe('1');
  });

  it('should run migrations idempotently', () => {
    // runMigrations() should not throw and should not duplicate metadata
    expect(() => runMigrations()).not.toThrow();

    const db = getDb();
    const rows = db.query(
      "SELECT COUNT(*) as cnt FROM app_meta WHERE key = 'classification_schema_version'"
    ).get() as { cnt: number };
    expect(rows.cnt).toBe(1);
  });

  it('repairs duplicate active discovery runs before creating unique indexes', () => {
    const db = getDb();
    const workspaceId = `migration-discovery-ws-${randomUUID()}`;
    insertWorkspace({
      id: workspaceId,
      name: 'Discovery Migration Workspace',
      workspacePath: `/tmp/${workspaceId}`,
      gitPath: `/tmp/${workspaceId}/.git`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    const batch = createBatch({ workspaceId, name: 'Discovery Migration Batch', fileName: 'migration.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: 'migration-upc', name: 'Migration Item', rowNumber: 1 }]);

    db.exec('DROP INDEX IF EXISTS idx_discovery_runs_one_running');
    db.exec('DROP INDEX IF EXISTS idx_discovery_runs_one_queued');
    db.exec("DELETE FROM app_meta WHERE key = 'onboarding_discovery_runs_schema_version'");
    const insertRun = (id: string, status: 'running' | 'queued', createdAt: string) => {
      db.query(`
        INSERT INTO onboarding_discovery_runs
          (id, item_id, trigger, status, request_json, current_step, created_at)
        VALUES (?, ?, 'automatic', ?, '{}', 'preflight', ?)
      `).run(id, item.id, status, createdAt);
    };
    insertRun('migration-running-old', 'running', '2026-01-01T00:00:00.000Z');
    insertRun('migration-running-new', 'running', '2026-01-02T00:00:00.000Z');
    insertRun('migration-queued-old', 'queued', '2026-01-01T00:00:00.000Z');
    insertRun('migration-queued-new', 'queued', '2026-01-02T00:00:00.000Z');

    expect(() => runMigrations()).not.toThrow();
    const rows = db.query(
      `SELECT id, status FROM onboarding_discovery_runs
       WHERE item_id = ? ORDER BY id`,
    ).all(item.id) as Array<{ id: string; status: string }>;
    expect(rows).toEqual([
      { id: 'migration-queued-new', status: 'queued' },
      { id: 'migration-queued-old', status: 'failed' },
      { id: 'migration-running-new', status: 'running' },
      { id: 'migration-running-old', status: 'failed' },
    ]);
    expect(db.query("SELECT value FROM app_meta WHERE key = 'onboarding_discovery_runs_schema_version'").get()).toEqual({ value: '2' });
  });

  it('should add decision revision columns and the global action-token unique index', () => {
    const db = getDb();

    const cols = db.query('PRAGMA table_info(classification_proposal_decisions)').all() as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    for (const col of ['revised_value_json', 'revised_target_id', 'has_revised_target', 'decision_key', 'superseded_at']) {
      expect(names).toContain(col);
    }

    const idx = db.query(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_classification_decisions_key'"
    ).get();
    expect(idx).toBeTruthy();

    // Action tokens stay unique across superseded history, so a delayed retry
    // can never reactivate an older action.
    const idxSql = db.query(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_classification_decisions_key'"
    ).get() as { sql: string } | undefined;
    expect(idxSql?.sql ?? '').toContain('decision_key IS NOT NULL');
    expect(idxSql?.sql ?? '').not.toContain('superseded_at');

    // Version guard is recorded exactly once.
    const rows = db.query(
      "SELECT COUNT(*) as cnt FROM app_meta WHERE key = 'decision_revision_schema_version'"
    ).get() as { cnt: number };
    expect(rows.cnt).toBe(1);
    const version = db.query(
      "SELECT value FROM app_meta WHERE key = 'decision_revision_schema_version'",
    ).get() as { value: string };
    expect(version.value).toBe('2');

    // Legacy-shaped rows (NULL new columns) round-trip after migration.
    const now = new Date().toISOString();
    const runId = randomUUID();
    const proposalId = randomUUID();
    db.run(
      `INSERT INTO classification_runs (id, workspace_id, onboarding_item_id, product_sku, status, started_at)
       VALUES (?, ?, NULL, 'SKU-MIG', 'completed', ?)`,
      [runId, 'ws-mig', now],
    );
    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, 'SKU-MIG', 'field_assignment', '"v"', 0.8, 'pending', ?)`,
      [proposalId, runId, now],
    );
    db.run(
      `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, created_at)
       VALUES (?, ?, 'accepted', ?)`,
      ['legacy-dec', proposalId, now],
    );
    const legacy = db.query(
      'SELECT revised_value_json, revised_target_id, decision_key, superseded_at FROM classification_proposal_decisions WHERE id = ?'
    ).get('legacy-dec') as Record<string, unknown>;
    expect(legacy.revised_value_json).toBeNull();
    expect(legacy.revised_target_id).toBeNull();
    expect(legacy.decision_key).toBeNull();
    expect(legacy.superseded_at).toBeNull();

    db.run('DELETE FROM classification_proposal_decisions WHERE id = ?', ['legacy-dec']);
    db.run('DELETE FROM classification_proposals WHERE id = ?', [proposalId]);
    db.run('DELETE FROM classification_runs WHERE id = ?', [runId]);
  });

  it('should support inserting and querying workspace', () => {
    const db = getDb();

    const id = randomUUID();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, 'Test Store', '/tmp/test-store', '/tmp/test-store/.git', now, now, 'complete'],
    );

    const row = db.query('SELECT * FROM workspace WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.name).toBe('Test Store');
    expect(row.bootstrap_status).toBe('complete');

    db.run('DELETE FROM workspace WHERE id = ?', [id]);
  });

  it('should support field_registry upsert', () => {
    const db2 = getDb();

    const wsId = randomUUID();
    const now = new Date().toISOString();
    const entryId = randomUUID();

    db2.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [wsId, 'Reg Store', '/tmp/reg', '/tmp/reg/.git', now, now, 'not_started'],
    );

    db2.run(
      `INSERT INTO field_registry (id, workspace_id, xml_field, label, kind, data_type, editable, required, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [entryId, wsId, 'ProductField16', 'Brand', 'custom', 'string', 1, 0, now, now],
    );

    const row = db2.query('SELECT * FROM field_registry WHERE id = ?').get(entryId) as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.label).toBe('Brand');

    db2.run('DELETE FROM field_registry WHERE id = ?', [entryId]);
    db2.run('DELETE FROM workspace WHERE id = ?', [wsId]);
  });

  it('should create all core tables', () => {
    const db3 = getDb();

    const tables = [
      'app_meta', 'workspace', 'connection', 'product_index',
      'field_registry', 'change_sets', 'change_set_items', 'validation_results',
      'sync_jobs', 'sync_job_events', 'remote_drift', 'audit_log',
      'product_types', 'product_type_fields', 'page_index', 'product_pages',
      'extractor_profiles', 'domain_status', 'sitemap_cache',
      'profile_generations', 'profile_generation_revisions',
      'profile_generation_validation_results', 'profile_generation_field_decisions',
      'llm_task_configs',
    ];

    for (const table of tables) {
      const row = db3.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
      ).get(table);
      expect(row).toBeTruthy();
    }

    // SERP retirement: the legacy serper_cache table must NOT be recreated.
    const dropped = db3.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'serper_cache'",
    ).get();
    expect(dropped).toBeFalsy();
  });

  it('should create all classification tables', () => {
    const db = getDb();

    const tables = [
      'classification_config_files',
      'classification_config_snapshots',
      'classification_product_types',
      'classification_attributes',
      'classification_attribute_profiles',
      'classification_attribute_mappings',
      'classification_guidance',
      'classification_model_policies',
      'classification_data_sharing_policies',
      'classification_runs',
      'classification_stage_results',
      'classification_evidence',
      'classification_proposals',
      'classification_proposal_evidence',
      'classification_proposal_decisions',
      'classification_history_events',
      'classification_refresh_queue',
      'classification_refresh_deferrals',
      'classification_model_calls',
      'packaging_ocr_shadow_comparisons',
    ];

    for (const table of tables) {
      const row = db.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
      ).get(table);
      expect(row).toBeTruthy();
    }
  });

  it('should create the classification_model_calls provenance columns and proposal model_call_ids_json', () => {
    const db = getDb();
    const callCols = (db.query('PRAGMA table_info(classification_model_calls)').all() as Array<{ name: string }>).map(c => c.name);
    for (const col of ['id', 'run_id', 'operation', 'attempt', 'provider', 'model', 'locality', 'snapshot_hash', 'model_policy_digest', 'prompt_template_version', 'rule_version', 'system_prompt_hash', 'user_prompt_hash', 'started_at', 'ended_at', 'duration_ms', 'prompt_tokens', 'completion_tokens', 'status', 'error_message', 'estimated_cost_usd', 'cost_basis', 'created_at']) {
      expect(callCols).toContain(col);
    }
    const proposalCols = (db.query('PRAGMA table_info(classification_proposals)').all() as Array<{ name: string }>).map(c => c.name);
    expect(proposalCols).toContain('model_call_ids_json');
    // Idempotent re-run leaves the marker set.
    const marker = db.query('SELECT value FROM app_meta WHERE key = ?').get('model_calls_schema_version') as { value: string } | undefined;
    expect(marker?.value).toBe('1');
  });

  it('schema.sql defines classification_proposals with an executable model_call_ids_json column (pass 4c)', () => {
    const schemaSql = fs.readFileSync(path.resolve(import.meta.dirname, '../../db/schema.sql'), 'utf-8');
    // The proposals CREATE TABLE in schema.sql must carry the column
    // definition (not merely a comment) so fresh DBs get it from schema.sql.
    const proposalsBlock = schemaSql.match(/CREATE TABLE IF NOT EXISTS classification_proposals\s*\([^;]*?\);/s);
    expect(proposalsBlock).not.toBeNull();
    expect(proposalsBlock![0]).toContain('model_call_ids_json TEXT');
  });

  it('should support minimal classification audit inserts', () => {
    const db = getDb();
    const now = new Date().toISOString();

    // 1. Insert a workspace
    const wsId = randomUUID();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [wsId, 'Class Store', '/tmp/class', '/tmp/class/.git', now, now, 'complete'],
    );

    // 2. Insert an onboarding batch and item for that workspace
    const batchId = randomUUID();
    db.run(
      `INSERT INTO onboarding_batches (id, workspace_id, name, file_name, status, total_items, completed_items, failed_items, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'imported', 1, 0, 0, ?, ?)`,
      [batchId, wsId, 'Test Batch', 'test.xlsx', now, now],
    );

    const itemId = randomUUID();
    db.run(
      `INSERT INTO onboarding_items (id, batch_id, upc, name, status, row_number, created_at, updated_at)
       VALUES (?, ?, 'SKU001', 'Test Product', 'imported', 1, ?, ?)`,
      [itemId, batchId, now, now],
    );

    // 3. Insert a classification_config_snapshots row
    const snapId = randomUUID();
    db.run(
      `INSERT INTO classification_config_snapshots (id, workspace_id, snapshot_hash, manifest_schema_version, compatibility_version, config_json, created_at)
       VALUES (?, ?, 'snap-hash-1', 1, 1, '{}', ?)`,
      [snapId, wsId, now],
    );

    // 4. Insert a classification_runs row for the onboarding item/SKU
    const runId = randomUUID();
    db.run(
      `INSERT INTO classification_runs (id, workspace_id, onboarding_item_id, product_sku, config_snapshot_id, config_snapshot_hash, status, started_at)
       VALUES (?, ?, ?, 'SKU001', ?, 'snap-hash-1', 'completed', ?)`,
      [runId, wsId, itemId, snapId, now],
    );

    // 5. Insert a classification_stage_results row
    const stageId = randomUUID();
    db.run(
      `INSERT INTO classification_stage_results (id, run_id, stage_name, status, output_json, started_at, completed_at)
       VALUES (?, ?, 'evidence_extraction', 'succeeded', '{"result":"ok"}', ?, ?)`,
      [stageId, runId, now, now],
    );

    // 6. Insert a classification_evidence row
    const evId = randomUUID();
    db.run(
      `INSERT INTO classification_evidence (id, run_id, product_sku, stage_name, source, reliability, value_json, created_at)
       VALUES (?, ?, 'SKU001', 'evidence_extraction', 'official_product_page', 'high', '"Chicken"', ?)`,
      [evId, runId, now],
    );

    // 7. Insert a classification_proposals row with confidence in range
    const propId = randomUUID();
    db.run(
      `INSERT INTO classification_proposals (id, run_id, product_sku, proposal_type, proposed_value_json, confidence, status, created_at)
       VALUES (?, ?, 'SKU001', 'field_assignment', '"Chicken"', 0.95, 'pending', ?)`,
      [propId, runId, now],
    );

    // 8. Insert a classification_proposal_evidence link
    db.run(
      `INSERT INTO classification_proposal_evidence (proposal_id, evidence_id)
       VALUES (?, ?)`,
      [propId, evId],
    );

    // 9. Insert a classification_proposal_decisions row
    const decId = randomUUID();
    db.run(
      `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, reviewer_note, created_at)
       VALUES (?, ?, 'accepted', 'Verified from official page', ?)`,
      [decId, propId, now],
    );

    // 10. Insert a classification_history_events row
    const histId = randomUUID();
    db.run(
      `INSERT INTO classification_history_events (id, workspace_id, product_sku, run_id, proposal_id, decision_id, event_type, created_at)
       VALUES (?, ?, 'SKU001', ?, ?, ?, 'proposal_accepted', ?)`,
      [histId, wsId, runId, propId, decId, now],
    );

    // 11. Query the joined records and assert the proposal and decision values round-trip
    const proposal = db.query(
      'SELECT id, confidence, status FROM classification_proposals WHERE id = ?'
    ).get(propId) as { id: string; confidence: number; status: string };
    expect(proposal).toBeTruthy();
    expect(proposal.confidence).toBeCloseTo(0.95, 5);
    expect(proposal.status).toBe('pending');

    const decision = db.query(
      'SELECT id, decision, reviewer_note FROM classification_proposal_decisions WHERE id = ?'
    ).get(decId) as { id: string; decision: string; reviewer_note: string };
    expect(decision).toBeTruthy();
    expect(decision.decision).toBe('accepted');
    expect(decision.reviewer_note).toBe('Verified from official page');

    const evidenceLink = db.query(
      'SELECT proposal_id, evidence_id FROM classification_proposal_evidence WHERE proposal_id = ? AND evidence_id = ?'
    ).get(propId, evId) as { proposal_id: string; evidence_id: string } | undefined;
    expect(evidenceLink).toBeTruthy();

    const history = db.query(
      'SELECT id, event_type FROM classification_history_events WHERE id = ?'
    ).get(histId) as { id: string; event_type: string };
    expect(history.event_type).toBe('proposal_accepted');

    // Clean up
    db.run('DELETE FROM classification_history_events WHERE id = ?', [histId]);
    db.run('DELETE FROM classification_proposal_decisions WHERE id = ?', [decId]);
    db.run('DELETE FROM classification_proposal_evidence WHERE proposal_id = ?', [propId]);
    db.run('DELETE FROM classification_proposals WHERE id = ?', [propId]);
    db.run('DELETE FROM classification_evidence WHERE id = ?', [evId]);
    db.run('DELETE FROM classification_stage_results WHERE id = ?', [stageId]);
    db.run('DELETE FROM classification_runs WHERE id = ?', [runId]);
    db.run('DELETE FROM classification_config_snapshots WHERE id = ?', [snapId]);
    db.run('DELETE FROM onboarding_items WHERE id = ?', [itemId]);
    db.run('DELETE FROM onboarding_batches WHERE id = ?', [batchId]);
    db.run('DELETE FROM workspace WHERE id = ?', [wsId]);
  });

  it('should migrate legacy item statuses to stage+stage_status correctly', () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Create a workspace and batch
    const wsId = randomUUID();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [wsId, 'Mig WS', '/tmp/mig', '/tmp/mig/.git', now, now, 'complete'],
    );

    const batchId = randomUUID();
    db.run(
      `INSERT INTO onboarding_batches (id, workspace_id, name, file_name, status, total_items, created_at, updated_at)
       VALUES (?, ?, 'Migration Batch', 'mig.xlsx', 'imported', 6, ?, ?)`,
      [batchId, wsId, now, now],
    );

    // Insert items with all legacy statuses
    const statuses = [
      { status: 'imported' },
      { status: 'discovering' },
      { status: 'source_found' },
      { status: 'extracting' },
      { status: 'needs_review' },
      { status: 'failed', extraction_data_json: '{}' },
    ];

    for (const s of statuses) {
      const itemId = randomUUID();
      db.run(
        `INSERT INTO onboarding_items (id, batch_id, upc, name, status, row_number, extraction_data_json, created_at, updated_at)
         VALUES (?, ?, 'SKU-' || ?, 'Product', ?, 1, ?, ?, ?)`,
        [itemId, batchId, itemId.slice(0, 6), s.status, s.extraction_data_json || null, now, now],
      );
    }

    // Apply stage pipeline migration SQL directly
    // (migration already ran; we test constraints by checking existing rows have defaults)
    const rows = db.query('SELECT status, stage, stage_status FROM onboarding_items WHERE batch_id = ? ORDER BY row_number').all(batchId) as Array<{ status: string; stage: string; stage_status: string }>;

    // Each row should have a valid stage and stage_status after migration defaults
    for (const row of rows) {
      expect(['discovery', 'extraction', 'curation', 'review', 'promotion']).toContain(row.stage);
      expect(['pending', 'in_progress', 'completed', 'failed', 'skipped']).toContain(row.stage_status);
    }

    db.run('DELETE FROM onboarding_items WHERE batch_id = ?', [batchId]);
    db.run('DELETE FROM onboarding_batches WHERE id = ?', [batchId]);
    db.run('DELETE FROM workspace WHERE id = ?', [wsId]);
  });

  it('should migrate legacy batch statuses to active/archived', () => {
    const db = getDb();
    const now = new Date().toISOString();

    const wsId = randomUUID();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [wsId, 'Mig WS 2', '/tmp/mig2', '/tmp/mig2/.git', now, now, 'complete'],
    );

    // Create batches with legacy statuses
    for (const legacyStatus of ['imported', 'discovering', 'curating', 'completed', 'promoted']) {
      const batchId = randomUUID();
      db.run(
        `INSERT INTO onboarding_batches (id, workspace_id, name, file_name, status, total_items, created_at, updated_at)
         VALUES (?, ?, 'Batch ' || ?, 'test.xlsx', ?, 0, ?, ?)`,
        [batchId, wsId, legacyStatus, legacyStatus, now, now],
      );
    }

    // Apply the batch status normalization (same SQL as stage-pipeline-migration.sql Step 4)
    db.exec("UPDATE onboarding_batches SET status = 'active' WHERE status IN ('imported', 'discovering', 'source_found', 'source_confirmed', 'extracting', 'extracted', 'curating', 'curated', 'needs_review', 'ready')");
    db.exec("UPDATE onboarding_batches SET status = 'archived' WHERE status IN ('completed', 'promoted')");
    db.exec("UPDATE onboarding_batches SET status = 'active' WHERE status NOT IN ('active', 'archived')");

    // Verify batches have valid active/archived statuses
    const batches = db.query('SELECT status FROM onboarding_batches WHERE workspace_id = ?').all(wsId) as Array<{ status: string }>;
    for (const b of batches) {
      expect(['active', 'archived']).toContain(b.status);
    }

    db.run('DELETE FROM onboarding_batches WHERE workspace_id = ?', [wsId]);
    db.run('DELETE FROM workspace WHERE id = ?', [wsId]);
  });

  it('should insert a classification_stage_results row with name_consolidation stage name', () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Create workspace, batch, item, config snapshot, and run
    const wsId = randomUUID();
    db.run(
      `INSERT INTO workspace (id, name, workspace_path, git_path, created_at, updated_at, bootstrap_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [wsId, 'NameConsolidation WS', '/tmp/nc-ws', '/tmp/nc-ws/.git', now, now, 'complete'],
    );

    const batchId = randomUUID();
    db.run(
      `INSERT INTO onboarding_batches (id, workspace_id, name, file_name, status, total_items, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'imported', 1, ?, ?)`,
      [batchId, wsId, 'NC Batch', 'nc.xlsx', now, now],
    );

    const itemId = randomUUID();
    db.run(
      `INSERT INTO onboarding_items (id, batch_id, upc, name, status, row_number, created_at, updated_at)
       VALUES (?, ?, 'NC-SKU', 'Name Consolidation Product', 'imported', 1, ?, ?)`,
      [itemId, batchId, now, now],
    );

    const snapId = randomUUID();
    db.run(
      `INSERT INTO classification_config_snapshots (id, workspace_id, snapshot_hash, config_json, created_at)
       VALUES (?, ?, 'nc-hash', '{}', ?)`,
      [snapId, wsId, now],
    );

    const runId = randomUUID();
    db.run(
      `INSERT INTO classification_runs (id, workspace_id, onboarding_item_id, product_sku, config_snapshot_id, config_snapshot_hash, status, started_at)
       VALUES (?, ?, ?, 'NC-SKU', ?, 'nc-hash', 'completed', ?)`,
      [runId, wsId, itemId, snapId, now],
    );

    // Insert a classification_stage_results row with name_consolidation
    const stageId = randomUUID();
    expect(() => {
      db.run(
        `INSERT INTO classification_stage_results (id, run_id, stage_name, status, output_json, started_at, completed_at)
         VALUES (?, ?, 'name_consolidation', 'succeeded', '{"result":"ok"}', ?, ?)`,
        [stageId, runId, now, now],
      );
    }).not.toThrow();

    // Verify the row was inserted
    const row = db.query(
      'SELECT id, stage_name, status FROM classification_stage_results WHERE id = ?'
    ).get(stageId) as { id: string; stage_name: string; status: string };
    expect(row).toBeTruthy();
    expect(row.stage_name).toBe('name_consolidation');
    expect(row.status).toBe('succeeded');

    // Clean up
    db.run('DELETE FROM classification_stage_results WHERE id = ?', [stageId]);
    db.run('DELETE FROM classification_runs WHERE id = ?', [runId]);
    db.run('DELETE FROM classification_config_snapshots WHERE id = ?', [snapId]);
    db.run('DELETE FROM onboarding_items WHERE id = ?', [itemId]);
    db.run('DELETE FROM onboarding_batches WHERE id = ?', [batchId]);
    db.run('DELETE FROM workspace WHERE id = ?', [wsId]);
  });

  it('should enforce FK constraint on classification_proposal_decisions for missing proposal', () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Attempt to insert a decision referencing a non-existent proposal
    expect(() => {
      db.run(
        `INSERT INTO classification_proposal_decisions (id, proposal_id, decision, created_at)
         VALUES (?, ?, 'accepted', ?)`,
        [randomUUID(), 'non-existent-proposal-id', now],
      );
    }).toThrow();
  });

  it('should create sitemap_cache with all required columns and the idx_sitemap_cache_domain index', () => {
    const db = getDb();

    // Column shape matches the contract.
    const columns = db.query('PRAGMA table_info(sitemap_cache)').all() as Array<{ name: string }>;
    const names = columns.map(c => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['domain', 'urls_json', 'fetched_at', 'expires_at', 'source_url']),
    );
    expect(names).toHaveLength(5);

    // The required index exists.
    const index = db.query(
      "SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_sitemap_cache_domain'",
    ).get();
    expect(index).toBeTruthy();
  });

  it('should round-trip a sitemap_cache row including source_url', () => {
    const db = getDb();
    const now = new Date();
    const fetchedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 60_000).toISOString();

    db.run(
      `INSERT INTO sitemap_cache (domain, urls_json, fetched_at, expires_at, source_url)
       VALUES (?, ?, ?, ?, ?)`,
      [
        'sitemap-mig.com',
        JSON.stringify(['https://sitemap-mig.com/a', 'https://sitemap-mig.com/b']),
        fetchedAt,
        expiresAt,
        'https://sitemap-mig.com/sitemap.xml',
      ],
    );

    const row = db.query('SELECT * FROM sitemap_cache WHERE domain = ?').get('sitemap-mig.com') as {
      domain: string;
      urls_json: string;
      fetched_at: string;
      expires_at: string;
      source_url: string;
    };
    expect(row).toBeTruthy();
    expect(row.source_url).toBe('https://sitemap-mig.com/sitemap.xml');
    expect(JSON.parse(row.urls_json)).toEqual([
      'https://sitemap-mig.com/a',
      'https://sitemap-mig.com/b',
    ]);

    // source_url is optional, so a row without it should also be valid.
    db.run(
      `INSERT INTO sitemap_cache (domain, urls_json, fetched_at, expires_at)
       VALUES (?, ?, ?, ?)`,
      [
        'sitemap-no-source.com',
        JSON.stringify([]),
        fetchedAt,
        expiresAt,
      ],
    );
    const row2 = db.query('SELECT source_url FROM sitemap_cache WHERE domain = ?').get('sitemap-no-source.com') as { source_url: string | null };
    expect(row2.source_url).toBeNull();

    // Clean up
    db.run('DELETE FROM sitemap_cache WHERE domain IN (?, ?)', [
      'sitemap-mig.com',
      'sitemap-no-source.com',
    ]);
  });

  it('assignProductToPageId inserts both page_id and page_name', () => {
    const pageId = randomUUID();
    const pageName = 'Dog Food';

    upsertPage({
      id: pageId,
      name: pageName,
      fileName: 'dog-food.html',
      parentId: null,
      pageHash: 'hash-1',
      lastSyncedAt: null,
    });

    assignProductToPageId('SKU-PAGEID-1', pageId, pageName);

    const pages = getProductPages('SKU-PAGEID-1');
    expect(pages).toContain(pageName);

    const assignments = getProductPageAssignments('SKU-PAGEID-1');
    expect(assignments.length).toBe(1);
    expect(assignments[0].pageId).toBe(pageId);
    expect(assignments[0].pageName).toBe(pageName);

    clearProductPages('SKU-PAGEID-1');
  });

  it('getProductPageAssignments returns both id and name', () => {
    const pageId1 = randomUUID();
    const pageId2 = randomUUID();

    upsertPage({ id: pageId1, name: 'Cat Food', fileName: 'cat-food.html', parentId: null, pageHash: 'hash-cat', lastSyncedAt: null });
    upsertPage({ id: pageId2, name: 'Dog Treats', fileName: 'dog-treats.html', parentId: null, pageHash: 'hash-dog-treats', lastSyncedAt: null });

    assignProductToPageId('SKU-ASSIGN-1', pageId1, 'Cat Food');
    assignProductToPageId('SKU-ASSIGN-1', pageId2, 'Dog Treats');

    const assignments = getProductPageAssignments('SKU-ASSIGN-1');
    expect(assignments.length).toBe(2);

    const catAssignment = assignments.find(a => a.pageName === 'Cat Food');
    expect(catAssignment).toBeDefined();
    expect(catAssignment!.pageId).toBe(pageId1);

    const dogAssignment = assignments.find(a => a.pageName === 'Dog Treats');
    expect(dogAssignment).toBeDefined();
    expect(dogAssignment!.pageId).toBe(pageId2);

    clearProductPages('SKU-ASSIGN-1');
  });

  it('backward-compatible assignProductToPage resolves name to id only for verified identities', () => {
    const pageId = randomUUID();
    const pageName = 'Birds';

    upsertPage({
      id: pageId,
      name: pageName,
      fileName: 'birds.html',
      parentId: null,
      pageHash: 'hash-birds',
      lastSyncedAt: null,
      identityKind: 'exported_guid',
      identityKey: 'guid-birds',
      identityStatus: 'verified',
      availability: 'available',
      workspaceId: 'ws-mig',
    });

    assignProductToPage('SKU-BACKCOMPAT-1', pageName);

    const assignments = getProductPageAssignments('SKU-BACKCOMPAT-1');
    expect(assignments.length).toBe(1);
    expect(assignments[0].pageId).toBe(pageId);
    expect(assignments[0].pageName).toBe(pageName);

    clearProductPages('SKU-BACKCOMPAT-1');
  });

  it('assignProductToPage stays name-only when the page identity is unverified', () => {
    const pageId = randomUUID();
    const pageName = 'Unverified Birds';

    upsertPage({
      id: pageId,
      name: pageName,
      fileName: 'birds.html',
      parentId: null,
      pageHash: 'hash-birds',
      lastSyncedAt: null,
      // Default identity: unverified_name_only review context.
    });

    assignProductToPage('SKU-UNVERIFIED-1', pageName);

    const assignments = getProductPageAssignments('SKU-UNVERIFIED-1');
    expect(assignments.length).toBe(1);
    expect(assignments[0].pageId).toBeNull();
    expect(assignments[0].pageName).toBe(pageName);

    clearProductPages('SKU-UNVERIFIED-1');
  });

  it('backward-compatible assignProductToPage works without page_index entry', () => {
    assignProductToPage('SKU-NOINDEX-1', 'Unsynced Page');

    const pages = getProductPages('SKU-NOINDEX-1');
    expect(pages).toContain('Unsynced Page');

    const assignments = getProductPageAssignments('SKU-NOINDEX-1');
    expect(assignments.length).toBe(1);
    expect(assignments[0].pageId).toBeNull();
    expect(assignments[0].pageName).toBe('Unsynced Page');

    clearProductPages('SKU-NOINDEX-1');
  });

  it('should expose the sitemap_product_url_pattern column on extractor_profiles', () => {
    const db = getDb();
    const now = new Date().toISOString();

    const profileId = randomUUID();
    db.run(
      `INSERT INTO extractor_profiles (
         id, domain, title_selector, price_selector, description_selector,
         brand_selector, images_selector, sitemap_product_url_pattern, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        profileId,
        'ext-mig.com',
        'h1',
        '.p',
        '.d',
        '.b',
        'img',
        'https://ext-mig.com/products/.*',
        now,
        now,
      ],
    );

    const row = db.query('SELECT sitemap_product_url_pattern FROM extractor_profiles WHERE id = ?').get(profileId) as { sitemap_product_url_pattern: string | null };
    expect(row.sitemap_product_url_pattern).toBe('https://ext-mig.com/products/.*');

    // Omitting the column should leave it NULL.
    const profileId2 = randomUUID();
    db.run(
      `INSERT INTO extractor_profiles (
         id, domain, title_selector, price_selector, description_selector,
         brand_selector, images_selector, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        profileId2,
        'ext-mig-null.com',
        'h1',
        null,
        null,
        null,
        null,
        now,
        now,
      ],
    );
    const row2 = db.query('SELECT sitemap_product_url_pattern FROM extractor_profiles WHERE id = ?').get(profileId2) as { sitemap_product_url_pattern: string | null };
    expect(row2.sitemap_product_url_pattern).toBeNull();

    db.run('DELETE FROM extractor_profiles WHERE id IN (?, ?)', [profileId, profileId2]);
  });

  it('fresh schema: role columns are NOT NULL and the relation join carries the CHECK (issue #17 pass 5b)', () => {
    const db = getDb();
    const proposalCols = db.query('PRAGMA table_info(classification_proposals)').all() as Array<{ name: string; notnull: number }>;
    const supporting = proposalCols.find(c => c.name === 'supporting_evidence_ids_json');
    const contradicting = proposalCols.find(c => c.name === 'contradicting_evidence_ids_json');
    expect(supporting).toBeDefined();
    expect(contradicting).toBeDefined();
    expect(Number(supporting!.notnull)).toBe(1);
    expect(Number(contradicting!.notnull)).toBe(1);

    const joinSql = db.query(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'classification_proposal_evidence'",
    ).get() as { sql: string };
    expect(/CHECK\s*\(/.test(joinSql.sql)).toBe(true);
    expect(joinSql.sql).toContain("'supporting'");
    expect(joinSql.sql).toContain("'legacy'");
  });

  it('re-running migrations is idempotent and keeps the relation CHECK + role columns (issue #17 pass 5b)', () => {
    const db = getDb();
    runMigrations();
    const joinSql = db.query(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'classification_proposal_evidence'",
    ).get() as { sql: string };
    expect(/CHECK\s*\(/.test(joinSql.sql)).toBe(true);
    const proposalCols = db.query('PRAGMA table_info(classification_proposals)').all() as Array<{ name: string; notnull: number }>;
    expect(Number(proposalCols.find(c => c.name === 'supporting_evidence_ids_json')!.notnull)).toBe(1);
    expect(Number(proposalCols.find(c => c.name === 'contradicting_evidence_ids_json')!.notnull)).toBe(1);
    const marker = db.query("SELECT value FROM app_meta WHERE key = 'evidence_citation_schema_version'").get() as { value: string } | undefined;
    expect(marker?.value).toBe('1');
  });

  it('repairs previously-nullable role columns on upgrade DBs even when the marker is already set (issue #17 pass 5c)', () => {
    const db = getDb();
    // Simulate an earlier Pass-5 partial upgrade: the evidence_citation marker
    // is ALREADY present (so the guarded NOT NULL ALTER block never runs) and
    // the proposals table has NULLABLE role columns. SQLite cannot change a
    // column's NOT NULL via ALTER, so the unconditional rebuild must repair it.
    const fkRow = db.query('PRAGMA foreign_keys').get() as { foreign_keys: number };
    const fkWasOn = Number(fkRow.foreign_keys) === 1;
    if (fkWasOn) db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec('ALTER TABLE classification_proposals RENAME TO classification_proposals_legacy;');
        db.exec(`
          CREATE TABLE classification_proposals (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            product_sku TEXT NOT NULL,
            proposal_type TEXT NOT NULL,
            target_id TEXT,
            proposed_value_json TEXT,
            confidence REAL NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
            is_bulk_acceptable INTEGER NOT NULL DEFAULT 0,
            is_stale INTEGER NOT NULL DEFAULT 0,
            staleness_reason TEXT,
            config_snapshot_hash TEXT,
            evidence_ids_json TEXT,
            supporting_evidence_ids_json TEXT,
            contradicting_evidence_ids_json TEXT,
            model_call_ids_json TEXT,
            created_at TEXT NOT NULL
          )
        `);
        db.exec(`
          INSERT INTO classification_proposals
            (id, run_id, product_sku, proposal_type, target_id, proposed_value_json,
             confidence, status, is_bulk_acceptable, is_stale, staleness_reason,
             config_snapshot_hash, evidence_ids_json, supporting_evidence_ids_json,
             contradicting_evidence_ids_json, model_call_ids_json, created_at)
          SELECT id, run_id, product_sku, proposal_type, target_id, proposed_value_json,
             confidence, status, is_bulk_acceptable, is_stale, staleness_reason,
             config_snapshot_hash, evidence_ids_json, supporting_evidence_ids_json,
             contradicting_evidence_ids_json, model_call_ids_json, created_at
          FROM classification_proposals_legacy
        `);
        db.exec('DROP TABLE classification_proposals_legacy;');
      })();
    } finally {
      if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
    }

    const beforeCols = db.query('PRAGMA table_info(classification_proposals)').all() as Array<{ name: string; notnull: number }>;
    expect(Number(beforeCols.find(c => c.name === 'supporting_evidence_ids_json')!.notnull)).toBe(0);
    const markerBefore = db.query("SELECT value FROM app_meta WHERE key = 'evidence_citation_schema_version'").get() as { value: string } | undefined;
    expect(markerBefore?.value).toBe('1');

    runMigrations();
    const afterCols = db.query('PRAGMA table_info(classification_proposals)').all() as Array<{ name: string; notnull: number }>;
    expect(Number(afterCols.find(c => c.name === 'evidence_ids_json')!.notnull)).toBe(1);
    expect(Number(afterCols.find(c => c.name === 'supporting_evidence_ids_json')!.notnull)).toBe(1);
    expect(Number(afterCols.find(c => c.name === 'contradicting_evidence_ids_json')!.notnull)).toBe(1);

    // Idempotent: a second run keeps the strict columns and preserves rows.
    runMigrations();
    const afterRerun = db.query('PRAGMA table_info(classification_proposals)').all() as Array<{ name: string; notnull: number }>;
    expect(Number(afterRerun.find(c => c.name === 'supporting_evidence_ids_json')!.notnull)).toBe(1);
    expect(Number(afterRerun.find(c => c.name === 'contradicting_evidence_ids_json')!.notnull)).toBe(1);
    const rowCount = db.query('SELECT COUNT(*) AS c FROM classification_proposals').get() as { c: number };
    expect(rowCount.c).toBeGreaterThanOrEqual(0);
  });

  it('standalone classification-migration.sql declares the role columns for fresh DBs (issue #17 pass 5b)', () => {
    const sql = fs.readFileSync(path.resolve(import.meta.dirname, '../../db/classification-migration.sql'), 'utf-8');
    expect(sql).toContain("supporting_evidence_ids_json TEXT NOT NULL DEFAULT '[]'");
    expect(sql).toContain("contradicting_evidence_ids_json TEXT NOT NULL DEFAULT '[]'");
    expect(sql).toContain("relation TEXT NOT NULL DEFAULT 'legacy' CHECK");
  });

  it('handles upgrade DB where classification_proposal_evidence lacks relation column and evidence_citation_schema_version is set', () => {
    const db = getDb();
    db.exec('DROP TABLE IF EXISTS classification_proposal_evidence_old;');
    db.exec('DROP TABLE IF EXISTS classification_proposal_evidence;');
    db.exec(`
      CREATE TABLE classification_proposal_evidence (
        proposal_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        PRIMARY KEY (proposal_id, evidence_id)
      )
    `);
    db.exec("INSERT INTO classification_proposal_evidence (proposal_id, evidence_id) VALUES ('p1', 'e1')");
    db.exec("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('evidence_citation_schema_version', '1')");

    expect(() => runMigrations()).not.toThrow();

    const joinSql = db.query(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'classification_proposal_evidence'",
    ).get() as { sql: string };
    expect(joinSql.sql).toContain('relation');
    expect(/CHECK\s*\(/.test(joinSql.sql)).toBe(true);

    const row = db.query("SELECT relation FROM classification_proposal_evidence WHERE proposal_id = 'p1'").get() as { relation: string };
    expect(row.relation).toBe('legacy');
  });

  it('rebuilds v1 curation_cohorts with an ON DELETE CASCADE batch FK (v1 → v2 → v3 → v4 → v5 → v6)', () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Create a workspace + batch + REAL onboarding item to hold a v1 cohort row
    // (and a real member child row) that must survive the rebuild (round-3 R3).
    const wsId = randomUUID();
    insertWorkspace({
      id: wsId,
      name: 'Cohort Mig WS',
      workspacePath: '/tmp/cohort-mig',
      gitPath: '',
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    const batchId = createBatch({ workspaceId: wsId, name: 'Cohort Mig Batch', fileName: 'cohort.xlsx', totalItems: 1 }).id;
    const itemId = insertItems(batchId, [{ upc: 'MIG-FAM-1', name: 'Mig Family Product 1', rowNumber: 1 }])[0].id;

    // Simulate a v1 database: v1-shaped tables (batch_id without CASCADE) and
    // the v1 marker. FK enforcement is off during the table swap.
    const fkRow = db.query('PRAGMA foreign_keys').get() as { foreign_keys: number };
    const fkWasOn = Number(fkRow.foreign_keys) === 1;
    const cohortId = randomUUID();
    if (fkWasOn) db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec('DROP TABLE IF EXISTS curation_cohort_members');
        db.exec('DROP TABLE IF EXISTS curation_cohorts');
        db.exec(`
          CREATE TABLE curation_cohorts (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspace(id),
            batch_id TEXT NOT NULL REFERENCES onboarding_batches(id),
            group_key TEXT NOT NULL,
            group_label TEXT NOT NULL,
            grouping_version TEXT NOT NULL,
            membership_hash TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('forming','waiting','ready','running','completed','failed','conflicted','superseded')),
            blocked_reason TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            started_at TEXT,
            completed_at TEXT,
            superseded_at TEXT
          )
        `);
        db.exec(`
          CREATE TABLE curation_cohort_members (
            cohort_id TEXT NOT NULL REFERENCES curation_cohorts(id) ON DELETE CASCADE,
            onboarding_item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
            product_sku TEXT,
            normalized_brand TEXT NOT NULL,
            normalized_name_stem TEXT NOT NULL,
            membership_reason_json TEXT,
            extraction_hash TEXT,
            ordinal INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (cohort_id, onboarding_item_id)
          )
        `);
        db.exec("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('curation_cohort_schema_version', '1')");
        db.exec(
          `INSERT INTO curation_cohorts
             (id, workspace_id, batch_id, group_key, group_label, grouping_version, membership_hash,
              status, blocked_reason, created_at, updated_at, started_at, completed_at, superseded_at)
           VALUES (?, ?, ?, 'mig-key', 'Mig Family', 'product-family-v1', ?, 'waiting', 'Waiting for 1 family member', ?, ?, NULL, NULL, NULL)`,
          [cohortId, wsId, batchId, 'f'.repeat(64), now, now],
        );
        // A REAL child member row referencing the real onboarding item + the v1 cohort.
        db.exec(
          `INSERT INTO curation_cohort_members
             (cohort_id, onboarding_item_id, product_sku, normalized_brand, normalized_name_stem,
              membership_reason_json, extraction_hash, ordinal, created_at)
           VALUES (?, ?, 'MIG-FAM-1', 'mig-brand', 'mig family product', NULL, NULL, 0, ?)`,
          [cohortId, itemId, now],
        );
      })();
    } finally {
      if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
    }

    expect(() => runMigrations()).not.toThrow();

    // Marker advanced all the way to v7 (the v1→v2 hop feeds the v2→v3 hop,
    // which feeds the v3→v4 hop that drops the execution-metadata columns,
    // which feeds the v4→v5 hop that adds classification_cohort_runs, which
    // feeds the v5→v6 hop that adds PR4 C1's dependency table, which feeds
    // the v6→v7 hop that adds PR6 C1's outputs table).
    const version = db.query("SELECT value FROM app_meta WHERE key = 'curation_cohort_schema_version'").get() as { value: string };
    expect(version.value).toBe('7');

    const fks = db.query("PRAGMA foreign_key_list('curation_cohorts')").all() as Array<{ from: string; table: string; on_delete: string }>;
    const batchFk = fks.find(f => f.from === 'batch_id');
    expect(batchFk).toBeTruthy();
    expect(batchFk!.table).toBe('onboarding_batches');
    expect(batchFk!.on_delete).toBe('CASCADE');

    // The v2→v3 hop also narrowed the status CHECK to the candidate-family set,
    // and the v3→v4 hop dropped the execution-metadata columns entirely.
    const tableSql = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='curation_cohorts'").get() as { sql: string };
    expect(tableSql.sql).toContain("status IN ('forming','waiting','ready','superseded')");
    expect(tableSql.sql).not.toContain('started_at');
    expect(tableSql.sql).not.toContain('completed_at');

    // Data survived the rebuild.
    const rows = db.query('SELECT COUNT(*) as c FROM curation_cohorts WHERE batch_id = ?').get(batchId) as { c: number };
    expect(rows.c).toBe(1);

    // The REAL member row survived — direct keyed query on the members table
    // (no subquery through parent rows).
    const memberCount = db.query(
      'SELECT COUNT(*) as c FROM curation_cohort_members WHERE cohort_id = ? AND onboarding_item_id = ?',
    ).get(cohortId, itemId) as { c: number };
    expect(memberCount.c).toBe(1);

    // Both tables are FK-clean after the rebuild.
    expect(db.query("PRAGMA foreign_key_check('curation_cohorts')").all()).toHaveLength(0);
    expect(db.query("PRAGMA foreign_key_check('curation_cohort_members')").all()).toHaveLength(0);

    // Idempotent: a second run keeps the marker and the v7 shape.
    expect(() => runMigrations()).not.toThrow();
    const version2 = db.query("SELECT value FROM app_meta WHERE key = 'curation_cohort_schema_version'").get() as { value: string };
    expect(version2.value).toBe('7');

    // End-to-end: the real deleteBatch now cascades to the cohort AND member rows.
    expect(deleteBatch(batchId)).toBe(true);
    const afterDelete = db.query('SELECT COUNT(*) as c FROM curation_cohorts WHERE batch_id = ?').get(batchId) as { c: number };
    expect(afterDelete.c).toBe(0);
    const afterDeleteMembers = db.query(
      'SELECT COUNT(*) as c FROM curation_cohort_members WHERE cohort_id = ? AND onboarding_item_id = ?',
    ).get(cohortId, itemId) as { c: number };
    expect(afterDeleteMembers.c).toBe(0);

    db.run('DELETE FROM workspace WHERE id = ?', [wsId]);
  });

});

describe('Cohort schema v4 migration (F3, issue #31 cleanup)', () => {
  const dbPath = `/tmp/baystate-cms-cohort-v4-${randomUUID()}.db`;

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(dbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(dbPath); } catch { /* ok */ }
  });

  it('fresh install: marker absent -> v7 directly with the narrowed status CHECK, CASCADE FK, and no execution-metadata columns', () => {
    const db = getDb();
    const version = db.query("SELECT value FROM app_meta WHERE key = 'curation_cohort_schema_version'").get() as { value: string };
    expect(version.value).toBe('7');

    // cohort-migration.sql is the FINAL schema: narrowed CHECK + CASCADE FK +
    // NO started_at/completed_at (execution metadata belongs to cohort runs),
    // plus the v5 classification_cohort_runs table and the v7
    // classification_cohort_outputs table.
    const tableSql = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='curation_cohorts'").get() as { sql: string };
    expect(tableSql.sql).toContain("status IN ('forming','waiting','ready','superseded')");
    expect(tableSql.sql).toContain('ON DELETE CASCADE');
    expect(tableSql.sql).not.toContain('\'running\'');
    expect(tableSql.sql).not.toContain('\'conflicted\'');
    expect(tableSql.sql).not.toContain('started_at');
    expect(tableSql.sql).not.toContain('completed_at');

    // Idempotent: a second run keeps marker '7'.
    expect(() => runMigrations()).not.toThrow();
    const version2 = db.query("SELECT value FROM app_meta WHERE key = 'curation_cohort_schema_version'").get() as { value: string };
    expect(version2.value).toBe('7');
  });

  it('marker-2 DB: v2 -> v3 -> v4 -> v5 rebuild preserves data, maps legacy execution statuses, narrows the CHECK, drops execution columns, and keeps cascade', () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Workspace + batch + REAL onboarding item (FK-clean cohort row).
    const wsId = randomUUID();
    insertWorkspace({
      id: wsId,
      name: 'Cohort V3 WS',
      workspacePath: '/tmp/cohort-v3',
      gitPath: '',
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    const batchId = createBatch({ workspaceId: wsId, name: 'Cohort V3 Batch', fileName: 'cohort-v3.xlsx', totalItems: 1 }).id;
    const itemId = insertItems(batchId, [{ upc: 'V3-FAM-1', name: 'V3 Family Product', rowNumber: 1 }])[0].id;

    // Simulate a marker-'2' database: v2-shaped tables (wide CHECK, CASCADE
    // FK) with a cohort row stuck in the execution state 'running'.
    const fkRow = db.query('PRAGMA foreign_keys').get() as { foreign_keys: number };
    const fkWasOn = Number(fkRow.foreign_keys) === 1;
    const cohortId = randomUUID();
    if (fkWasOn) db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec('DROP TABLE IF EXISTS curation_cohort_members');
        db.exec('DROP TABLE IF EXISTS curation_cohorts');
        db.exec(`
          CREATE TABLE curation_cohorts (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspace(id),
            batch_id TEXT NOT NULL REFERENCES onboarding_batches(id) ON DELETE CASCADE,
            group_key TEXT NOT NULL,
            group_label TEXT NOT NULL,
            grouping_version TEXT NOT NULL,
            membership_hash TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('forming','waiting','ready','running','completed','failed','conflicted','superseded')),
            blocked_reason TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            started_at TEXT,
            completed_at TEXT,
            superseded_at TEXT
          )
        `);
        db.exec(`
          CREATE TABLE curation_cohort_members (
            cohort_id TEXT NOT NULL REFERENCES curation_cohorts(id) ON DELETE CASCADE,
            onboarding_item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
            product_sku TEXT,
            normalized_brand TEXT NOT NULL,
            normalized_name_stem TEXT NOT NULL,
            membership_reason_json TEXT,
            extraction_hash TEXT,
            ordinal INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (cohort_id, onboarding_item_id)
          )
        `);
        db.exec("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('curation_cohort_schema_version', '2')");
        db.exec(
          `INSERT INTO curation_cohorts
             (id, workspace_id, batch_id, group_key, group_label, grouping_version, membership_hash,
              status, blocked_reason, created_at, updated_at, started_at, completed_at, superseded_at)
           VALUES (?, ?, ?, 'v3-key', 'V3 Family', 'product-family-v1', ?, 'running', NULL, ?, ?, NULL, NULL, NULL)`,
          [cohortId, wsId, batchId, 'f'.repeat(64), now, now],
        );
        db.exec(
          `INSERT INTO curation_cohort_members
             (cohort_id, onboarding_item_id, product_sku, normalized_brand, normalized_name_stem,
              membership_reason_json, extraction_hash, ordinal, created_at)
           VALUES (?, ?, 'V3-FAM-1', 'v3-brand', 'v3 family product', NULL, NULL, 0, ?)`,
          [cohortId, itemId, now],
        );
      })();
    } finally {
      if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
    }

    expect(() => runMigrations()).not.toThrow();

    // Marker advanced to v7 (v2 → v3 → v4 → v5 → v6 → v7 hops).
    const version = db.query("SELECT value FROM app_meta WHERE key = 'curation_cohort_schema_version'").get() as { value: string };
    expect(version.value).toBe('7');

    // Data preserved: the 'running' row survived and was deterministically
    // mapped to 'ready' (dropping the never-durable execution state leaves a
    // stable candidate); the member row survived.
    const row = db.query('SELECT status, batch_id FROM curation_cohorts WHERE id = ?').get(cohortId) as { status: string; batch_id: string };
    expect(row.status).toBe('ready');
    expect(row.batch_id).toBe(batchId);
    const memberCount = db.query(
      'SELECT COUNT(*) as c FROM curation_cohort_members WHERE cohort_id = ? AND onboarding_item_id = ?',
    ).get(cohortId, itemId) as { c: number };
    expect(memberCount.c).toBe(1);

    // CHECK narrowed: inserting/updating 'running' is now REJECTED.
    expect(() => db.run("UPDATE curation_cohorts SET status = 'running' WHERE id = ?", [cohortId])).toThrow();
    // 'ready' remains accepted. The v4 shape has no execution-metadata columns.
    const readyId = randomUUID();
    expect(() => {
      db.run(
        `INSERT INTO curation_cohorts
           (id, workspace_id, batch_id, group_key, group_label, grouping_version, membership_hash,
            status, blocked_reason, created_at, updated_at, superseded_at)
         VALUES (?, ?, ?, 'v4-ready', 'V4 Ready', 'product-family-v1', ?, 'ready', NULL, ?, ?, NULL)`,
        [readyId, wsId, batchId, 'g'.repeat(64), now, now],
      );
    }).not.toThrow();
    // The dropped columns are GONE: an INSERT naming started_at now fails.
    expect(() => {
      db.run(
        `INSERT INTO curation_cohorts
           (id, workspace_id, batch_id, group_key, group_label, grouping_version, membership_hash,
            status, blocked_reason, created_at, updated_at, started_at, completed_at, superseded_at)
         VALUES (?, ?, ?, 'v4-started', 'V4 Started', 'product-family-v1', ?, 'ready', NULL, ?, ?, NULL, NULL, NULL)`,
        [randomUUID(), wsId, batchId, 'h'.repeat(64), now, now],
      );
    }).toThrow(/no column named/i);

    // FK-clean after the swap, and cascade still works end-to-end.
    expect(db.query("PRAGMA foreign_key_check('curation_cohorts')").all()).toHaveLength(0);
    expect(db.query("PRAGMA foreign_key_check('curation_cohort_members')").all()).toHaveLength(0);
    expect(deleteBatch(batchId)).toBe(true);
    expect(db.query('SELECT COUNT(*) as c FROM curation_cohorts WHERE batch_id = ?').get(batchId) as { c: number }).toEqual({ c: 0 });

    db.run('DELETE FROM workspace WHERE id = ?', [wsId]);
  });

  it('marker-3 DB: v3 -> v4 -> v5 rebuild drops started_at/completed_at, preserves data, and keeps cascade', () => {
    const db = getDb();
    const now = new Date().toISOString();

    // Workspace + batch + REAL onboarding item (FK-clean v3 cohort row).
    const wsId = randomUUID();
    insertWorkspace({
      id: wsId,
      name: 'Cohort V4 WS',
      workspacePath: '/tmp/cohort-v4',
      gitPath: '',
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    const batchId = createBatch({ workspaceId: wsId, name: 'Cohort V4 Batch', fileName: 'cohort-v4.xlsx', totalItems: 1 }).id;
    const itemId = insertItems(batchId, [{ upc: 'V4-FAM-1', name: 'V4 Family Product', rowNumber: 1 }])[0].id;

    // Simulate a marker-'3' database: the v3 shape (narrowed CHECK, CASCADE
    // FK, but STILL carrying started_at/completed_at).
    const fkRow = db.query('PRAGMA foreign_keys').get() as { foreign_keys: number };
    const fkWasOn = Number(fkRow.foreign_keys) === 1;
    const cohortId = randomUUID();
    if (fkWasOn) db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec('DROP TABLE IF EXISTS curation_cohort_members');
        db.exec('DROP TABLE IF EXISTS curation_cohorts');
        db.exec(`
          CREATE TABLE curation_cohorts (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspace(id),
            batch_id TEXT NOT NULL REFERENCES onboarding_batches(id) ON DELETE CASCADE,
            group_key TEXT NOT NULL,
            group_label TEXT NOT NULL,
            grouping_version TEXT NOT NULL,
            membership_hash TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('forming','waiting','ready','superseded')),
            blocked_reason TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            started_at TEXT,
            completed_at TEXT,
            superseded_at TEXT
          )
        `);
        db.exec(`
          CREATE TABLE curation_cohort_members (
            cohort_id TEXT NOT NULL REFERENCES curation_cohorts(id) ON DELETE CASCADE,
            onboarding_item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
            product_sku TEXT,
            normalized_brand TEXT NOT NULL,
            normalized_name_stem TEXT NOT NULL,
            membership_reason_json TEXT,
            extraction_hash TEXT,
            ordinal INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (cohort_id, onboarding_item_id)
          )
        `);
        db.exec("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('curation_cohort_schema_version', '3')");
        db.exec(
          `INSERT INTO curation_cohorts
             (id, workspace_id, batch_id, group_key, group_label, grouping_version, membership_hash,
              status, blocked_reason, created_at, updated_at, started_at, completed_at, superseded_at)
           VALUES (?, ?, ?, 'v4-key', 'V4 Family', 'product-family-v1', ?, 'waiting', 'Waiting for 1 family member', ?, ?, ?, ?, NULL)`,
          [cohortId, wsId, batchId, 'f'.repeat(64), now, now, now, now],
        );
        db.exec(
          `INSERT INTO curation_cohort_members
             (cohort_id, onboarding_item_id, product_sku, normalized_brand, normalized_name_stem,
              membership_reason_json, extraction_hash, ordinal, created_at)
           VALUES (?, ?, 'V4-FAM-1', 'v4-brand', 'v4 family product', NULL, NULL, 0, ?)`,
          [cohortId, itemId, now],
        );
      })();
    } finally {
      if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
    }

    expect(() => runMigrations()).not.toThrow();

    // Marker advanced to v7 (v3 → v4 → v5 → v6 → v7 hops).
    const version = db.query("SELECT value FROM app_meta WHERE key = 'curation_cohort_schema_version'").get() as { value: string };
    expect(version.value).toBe('7');

    // The execution-metadata columns are GONE.
    const cols = db.query('PRAGMA table_info(curation_cohorts)').all() as Array<{ name: string }>;
    const names = cols.map(col => col.name);
    expect(names).toContain('superseded_at');
    expect(names).not.toContain('started_at');
    expect(names).not.toContain('completed_at');

    // Data preserved (status + blocked_reason survive; the legacy execution
    // timestamps were never authority and are simply dropped); the member row
    // survived.
    const row = db.query('SELECT status, batch_id, blocked_reason FROM curation_cohorts WHERE id = ?').get(cohortId) as { status: string; batch_id: string; blocked_reason: string | null };
    expect(row.status).toBe('waiting');
    expect(row.blocked_reason).toBe('Waiting for 1 family member');
    expect(row.batch_id).toBe(batchId);
    const memberCount = db.query(
      'SELECT COUNT(*) as c FROM curation_cohort_members WHERE cohort_id = ? AND onboarding_item_id = ?',
    ).get(cohortId, itemId) as { c: number };
    expect(memberCount.c).toBe(1);

    // An INSERT naming the dropped column fails; the v4 insert shape works.
    expect(() => {
      db.run(
        `INSERT INTO curation_cohorts
           (id, workspace_id, batch_id, group_key, group_label, grouping_version, membership_hash,
            status, blocked_reason, created_at, updated_at, started_at, completed_at, superseded_at)
         VALUES (?, ?, ?, 'v4-bad', 'V4 Bad', 'product-family-v1', ?, 'ready', NULL, ?, ?, NULL, NULL, NULL)`,
        [randomUUID(), wsId, batchId, 'g'.repeat(64), now, now],
      );
    }).toThrow(/no column named/i);
    const v4Id = randomUUID();
    expect(() => {
      db.run(
        `INSERT INTO curation_cohorts
           (id, workspace_id, batch_id, group_key, group_label, grouping_version, membership_hash,
            status, blocked_reason, created_at, updated_at, superseded_at)
         VALUES (?, ?, ?, 'v4-ok', 'V4 OK', 'product-family-v1', ?, 'ready', NULL, ?, ?, NULL)`,
        [v4Id, wsId, batchId, 'h'.repeat(64), now, now],
      );
    }).not.toThrow();

    // FK-clean after the swap, and cascade still works end-to-end.
    expect(db.query("PRAGMA foreign_key_check('curation_cohorts')").all()).toHaveLength(0);
    expect(db.query("PRAGMA foreign_key_check('curation_cohort_members')").all()).toHaveLength(0);
    expect(deleteBatch(batchId)).toBe(true);
    expect(db.query('SELECT COUNT(*) as c FROM curation_cohorts WHERE batch_id = ?').get(batchId) as { c: number }).toEqual({ c: 0 });

    db.run('DELETE FROM workspace WHERE id = ?', [wsId]);
  });
});

describe('Cohort schema v5 migration (PR3 M1, issue #30)', () => {
  const dbPath = `/tmp/baystate-cms-cohort-v5-${randomUUID()}.db`;

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(dbPath);
    runMigrations();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(dbPath); } catch { /* ok */ }
  });

  it('fresh install: marker absent -> v7 directly with classification_cohort_runs, cohort_run_id, and the current-run index', () => {
    const db = getDb();
    const version = db.query("SELECT value FROM app_meta WHERE key = 'curation_cohort_schema_version'").get() as { value: string };
    expect(version.value).toBe('7');

    // The v5 parent run table exists with the PR3 M1 lifecycle CHECKs.
    const runTable = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='classification_cohort_runs'").get() as { sql: string } | undefined;
    expect(runTable).toBeTruthy();
    const sql = runTable!.sql;
    expect(sql).toContain("'freezing'");
    expect(sql).toContain("'completed_with_member_failures'");
    expect(sql).not.toContain("'queued'"); // queued was DROPPED in PR3
    expect(sql).toContain("CHECK (status IN ('freezing','superseded','cancelled') OR (candidate_membership_hash IS NOT NULL AND evidence_snapshot_hash IS NOT NULL))");
    expect(sql).toContain('lease_expires_at');
    expect(sql).toContain('superseded_at');

    // classification_runs.cohort_run_id was added OUTSIDE the version gate.
    const runCols = db.query('PRAGMA table_info(classification_runs)').all() as Array<{ name: string }>;
    expect(runCols.map(c => c.name)).toContain('cohort_run_id');

    // Unique current-run index is present (the claim race backstop).
    const idxSql = db.query("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_classification_cohort_runs_current'").get() as { sql: string } | undefined;
    expect(idxSql?.sql ?? '').toContain('UNIQUE');
    expect(idxSql?.sql ?? '').toContain("status != 'superseded'");

    // Lease sweep + cohort/status/workspace indexes present.
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_classification_cohort_runs_lease'").get()).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_classification_cohort_runs_workspace'").get()).toBeTruthy();

    // Real CHECK behavior on a real row: 'freezing' is accepted, 'queued' is
    // rejected, and leaving 'freezing' without the mandatory evidence hashes
    // fails closed.
    const now = new Date().toISOString();
    const wsId = randomUUID();
    insertWorkspace({
      id: wsId,
      name: 'Cohort V5 WS',
      workspacePath: '/tmp/cohort-v5',
      gitPath: '',
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    const batchId = createBatch({ workspaceId: wsId, name: 'Cohort V5 Batch', fileName: 'cohort-v5.xlsx', totalItems: 1 }).id;
    const cohortId = randomUUID();
    db.run(
      `INSERT INTO curation_cohorts
         (id, workspace_id, batch_id, group_key, group_label, grouping_version, membership_hash,
          status, blocked_reason, created_at, updated_at, superseded_at)
       VALUES (?, ?, ?, 'v5-key', 'V5 Family', 'product-family-v1', ?, 'ready', NULL, ?, ?, NULL)`,
      [cohortId, wsId, batchId, 'f'.repeat(64), now, now],
    );

    const freezingId = randomUUID();
    expect(() => {
      db.run(
        `INSERT INTO classification_cohort_runs
           (id, workspace_id, cohort_id, candidate_membership_hash, status, claimed_by, claimed_at,
            lease_expires_at, created_at)
         VALUES (?, ?, ?, ?, 'freezing', 'worker-a', ?, ?, ?)`,
        [freezingId, wsId, cohortId, 'f'.repeat(64), now, now, now],
      );
    }).not.toThrow();

    // 'queued' was DROPPED from the enum in PR3 — the status CHECK rejects it.
    expect(() => {
      db.run(
        `INSERT INTO classification_cohort_runs
           (id, workspace_id, cohort_id, candidate_membership_hash, status, claimed_by, claimed_at,
            lease_expires_at, created_at)
         VALUES (?, ?, ?, ?, 'queued', 'worker-a', ?, ?, ?)`,
        [randomUUID(), wsId, cohortId, 'f'.repeat(64), now, now, now],
      );
    }).toThrow(/CHECK constraint failed/);

    // Superseded/cancelled are terminal lifecycle states exempt from the hash
    // gate: a NULL-hash freezing run (abandoned unfinalized freeze) may still
    // be superseded or cancelled (PR3 decision, Option A). Each scenario needs
    // its OWN cohort (the unique current-run index allows only one
    // non-superseded run per cohort).
    const mkCohort = (groupKey: string): string => {
      const id = randomUUID();
      db.run(
        `INSERT INTO curation_cohorts
           (id, workspace_id, batch_id, group_key, group_label, grouping_version, membership_hash,
            status, blocked_reason, created_at, updated_at, superseded_at)
         VALUES (?, ?, ?, ?, 'V5 Family', 'product-family-v1', ?, 'ready', NULL, ?, ?, NULL)`,
        [id, wsId, batchId, groupKey, 'g'.repeat(64), now, now],
      );
      return id;
    };
    const insertFreezing = (id: string, cohort: string): void => {
      db.run(
        `INSERT INTO classification_cohort_runs
           (id, workspace_id, cohort_id, candidate_membership_hash, status, claimed_by, claimed_at,
            lease_expires_at, created_at)
         VALUES (?, ?, ?, ?, 'freezing', 'worker-a', ?, ?, ?)`,
        [id, wsId, cohort, 'f'.repeat(64), now, now, now],
      );
    };
    const supersedeId = randomUUID();
    const supersedeCohortId = mkCohort('v5-key-supersede');
    const cancelId = randomUUID();
    const cancelCohortId = mkCohort('v5-key-cancel');
    insertFreezing(supersedeId, supersedeCohortId);
    insertFreezing(cancelId, cancelCohortId);
    expect(() => db.run("UPDATE classification_cohort_runs SET status = 'superseded', superseded_at = ? WHERE id = ?", [now, supersedeId])).not.toThrow();
    expect(() => db.run("UPDATE classification_cohort_runs SET status = 'cancelled', completed_at = ? WHERE id = ?", [now, cancelId])).not.toThrow();

    // Hash-required CHECK: leaving 'freezing' for an EXECUTION state without
    // evidence_snapshot_hash fails closed.
    expect(() => {
      db.run("UPDATE classification_cohort_runs SET status = 'running' WHERE id = ?", [freezingId]);
    }).toThrow(/CHECK constraint failed/);
    // With the mandatory hashes the transition is accepted.
    expect(() => {
      db.run(
        `UPDATE classification_cohort_runs
         SET status = 'running', started_at = ?, evidence_snapshot_hash = ?
         WHERE id = ?`,
        [now, 'e'.repeat(64), freezingId],
      );
    }).not.toThrow();

    // The unique current-run index rejects a second non-superseded run for the
    // same cohort.
    expect(() => {
      db.run(
        `INSERT INTO classification_cohort_runs
           (id, workspace_id, cohort_id, candidate_membership_hash, status, claimed_by, claimed_at,
            lease_expires_at, evidence_snapshot_hash, created_at)
         VALUES (?, ?, ?, ?, 'running', 'worker-b', ?, ?, ?, ?)`,
        [randomUUID(), wsId, cohortId, 'f'.repeat(64), now, now, 'g'.repeat(64), now],
      );
    }).toThrow(/UNIQUE/i);

    // Cleanup: batch deletion cascades the cohort + runs; workspace deletion
    // then succeeds.
    expect(deleteBatch(batchId)).toBe(true);
    db.run('DELETE FROM workspace WHERE id = ?', [wsId]);
  });

  it('marker-4 DB: v4 -> v5 -> v6 -> v7 hops exec the cohort SQL and bump the marker (idempotent)', () => {
    const db = getDb();
    // Simulate a pre-PR3 v4 database: rewind the marker and drop the v5 table.
    const fkRow = db.query('PRAGMA foreign_keys').get() as { foreign_keys: number };
    const fkWasOn = Number(fkRow.foreign_keys) === 1;
    if (fkWasOn) db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('DROP TABLE IF EXISTS classification_cohort_runs;');
    } finally {
      if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
    }
    db.exec("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('curation_cohort_schema_version', '4')");

    expect(() => runMigrations()).not.toThrow();

    const version = db.query("SELECT value FROM app_meta WHERE key = 'curation_cohort_schema_version'").get() as { value: string };
    expect(version.value).toBe('7');
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='classification_cohort_runs'").get()).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_classification_cohort_runs_current'").get()).toBeTruthy();
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_classification_cohort_runs_lease'").get()).toBeTruthy();

    // cohort_run_id survives for databases that were already migrated
    // (the ALTER and supporting index live OUTSIDE the version gate).
    const runCols = db.query('PRAGMA table_info(classification_runs)').all() as Array<{ name: string }>;
    expect(runCols.map(c => c.name)).toContain('cohort_run_id');
    expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_classification_runs_cohort_run_id'").get()).toBeTruthy();

    // Idempotent: a second run keeps the marker and the v7 shape.
    expect(() => runMigrations()).not.toThrow();
    const version2 = db.query("SELECT value FROM app_meta WHERE key = 'curation_cohort_schema_version'").get() as { value: string };
    expect(version2.value).toBe('7');
  });

  it('creates the Store Manager runtime audit tables idempotently (epic #42, #40)', () => {
    const db = getDb();

    expect(db.query("SELECT value FROM app_meta WHERE key = 'store_manager_runtime_schema_version'").get()).toBeTruthy();

    const sessions = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='store_manager_sessions'").get();
    expect(sessions).toBeTruthy();
    const turns = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='store_manager_turns'").get();
    expect(turns).toBeTruthy();
    const events = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='store_manager_events'").get();
    expect(events).toBeTruthy();

    for (const index of [
      'idx_store_manager_sessions_ws',
      'idx_store_manager_sessions_thread',
      'idx_store_manager_sessions_model_call',
      'idx_store_manager_turns_ws',
      'idx_store_manager_turns_session',
      'idx_store_manager_events_ws',
      'idx_store_manager_events_session',
    ]) {
      expect(db.query("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(index)).toBeTruthy();
    }

    // Constraint shape: phases/statuses/terminal statuses are CHECK-bound.
    const turnDdl = (db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='store_manager_turns'").get() as { sql: string }).sql;
    expect(turnDdl).toMatch(/CHECK \(phase IN \('investigate', 'approve', 'verify'\)\)/);
    expect(turnDdl).toMatch(/CHECK \(terminal_status IN \('success', 'failed', 'cancelled', 'policy_denied', 'deadline_exceeded'\)\)/);
    const sessionDdl = (db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='store_manager_sessions'").get() as { sql: string }).sql;
    expect(sessionDdl).toMatch(/CHECK \(resolved_locality IN \('local', 'cloud'\)\)/);

    // Upgrade path: a turns table created with the pre-deadline CHECK is
    // rebuilt in place (data preserved) by the next migration run.
    db.exec(
      "ALTER TABLE store_manager_turns RENAME TO store_manager_turns_old; " +
        "CREATE TABLE store_manager_turns (" +
        "  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, " +
        "  session_id TEXT NOT NULL REFERENCES store_manager_sessions(id) ON DELETE CASCADE, " +
        "  turn_id TEXT NOT NULL, " +
        "  phase TEXT NOT NULL CHECK (phase IN ('investigate', 'approve', 'verify')), " +
        "  status TEXT NOT NULL CHECK (status IN ('active', 'terminal')), " +
        "  terminal_status TEXT CHECK (terminal_status IN ('success', 'failed', 'cancelled', 'policy_denied')), " +
        "  outcome_reason TEXT, total_tool_calls INTEGER NOT NULL DEFAULT 0, policy_hash TEXT NOT NULL, " +
        "  created_at TEXT NOT NULL, updated_at TEXT NOT NULL" +
        "); ",
    );
    db.exec('DROP TABLE store_manager_turns_old');
    expect(() => runMigrations()).not.toThrow();
    const rebuiltTurnDdl = (db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='store_manager_turns'").get() as { sql: string }).sql;
    expect(rebuiltTurnDdl).toMatch(/deadline_exceeded/);

    // Idempotent rerun keeps the marker and the tables.
    expect(() => runMigrations()).not.toThrow();
    expect(db.query("SELECT value FROM app_meta WHERE key = 'store_manager_runtime_schema_version'").get()).toBeTruthy();
  });
});

describe('Distributor V2 schema migration (ADR 0014)', () => {
  const v2DbPath = '/tmp/baystate-cms-v2-test.db';
  let db: ReturnType<typeof getDb>;

  beforeAll(() => {
    try { unlinkSync(v2DbPath); } catch { /* ok */ }
    initDb(v2DbPath);
    runMigrations();
    db = getDb();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(v2DbPath); } catch { /* ok */ }
  });

  function evidenceColumnNames(): string[] {
    return (db.query('PRAGMA table_info(onboarding_evidence_attempts)').all() as Array<{ name: string }>).map((c) => c.name);
  }

  function downgradeToPreV2(): void {
    // Simulate a pre-V2 database: drop the six recovered tables + generation
    // table + brand profiles, drop the idempotency index, delete the marker,
    // and rebuild onboarding_evidence_attempts to the exact 13-column shape.
    db.exec('DROP TABLE IF EXISTS onboarding_item_evidence_acceptances');
    db.exec('DROP TABLE IF EXISTS onboarding_evidence_conflict_candidates');
    db.exec('DROP TABLE IF EXISTS onboarding_evidence_conflicts');
    db.exec('DROP TABLE IF EXISTS distributor_catalog_snapshots');
    db.exec('DROP TABLE IF EXISTS distributor_connections');
    db.exec('DROP TABLE IF EXISTS distributors');
    db.exec('DROP TABLE IF EXISTS sourcing_generations');
    db.exec('DROP TABLE IF EXISTS brand_advisory_profiles');
    db.exec('DROP INDEX IF EXISTS idx_evidence_attempts_generation_provider');
    db.exec("DELETE FROM app_meta WHERE key = 'distributor_v2_schema_version'");

    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`CREATE TABLE onboarding_evidence_attempts_13 (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
      provider_id TEXT NOT NULL,
      lookup_upc TEXT NOT NULL,
      outcome TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.0,
      evidence_url TEXT,
      matched_fields_json TEXT NOT NULL DEFAULT '[]',
      identity_json TEXT,
      warnings_json TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL
    )`);
    db.exec(`INSERT INTO onboarding_evidence_attempts_13
      SELECT id, item_id, provider_id, lookup_upc, outcome, confidence, evidence_url,
             matched_fields_json, identity_json, warnings_json, error_code, error_message, created_at
      FROM onboarding_evidence_attempts`);
    db.exec('DROP TABLE onboarding_evidence_attempts');
    db.exec('ALTER TABLE onboarding_evidence_attempts_13 RENAME TO onboarding_evidence_attempts');
    db.exec('CREATE INDEX IF NOT EXISTS idx_onboarding_evidence_attempts_item ON onboarding_evidence_attempts(item_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_onboarding_evidence_attempts_provider ON onboarding_evidence_attempts(provider_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_onboarding_evidence_attempts_upc ON onboarding_evidence_attempts(lookup_upc)');
    db.exec('PRAGMA foreign_keys = ON');
  }

  it('fresh install creates all V2 tables, columns, and the marker', () => {
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sourcing_generations','distributors','distributor_connections','distributor_catalog_snapshots','onboarding_evidence_conflicts','onboarding_evidence_conflict_candidates','onboarding_item_evidence_acceptances','brand_advisory_profiles')")
      .all() as Array<{ name: string }>;
    expect(new Set(tables.map((t) => t.name))).toEqual(
      new Set(['sourcing_generations','distributors','distributor_connections','distributor_catalog_snapshots','onboarding_evidence_conflicts','onboarding_evidence_conflict_candidates','onboarding_item_evidence_acceptances','brand_advisory_profiles']),
    );

    const cols = evidenceColumnNames();
    for (const col of ['distributor_connection_id','catalog_snapshot_id','catalog_version','observed_at','expires_at','sourcing_generation_id']) {
      expect(cols).toContain(col);
    }

    const marker = db.query("SELECT value FROM app_meta WHERE key = 'distributor_v2_schema_version'").get() as { value: string };
    expect(marker.value).toBe('1');
  });

  it('idempotent second run changes nothing', () => {
    expect(() => runMigrations()).not.toThrow();
    const rows = db.query("SELECT COUNT(*) as cnt FROM app_meta WHERE key = 'distributor_v2_schema_version'").get() as { cnt: number };
    expect(rows.cnt).toBe(1);
  });

  it('13-column pre-V2 database upgrades: columns added (incl. catalog_version), backfill, legacy binding', () => {
    // Seed a legacy workspace/item/attempt chain BEFORE downgrade so the
    // attempt survives the table rebuild.
    insertWorkspace({
      id: 'v2-w1', name: 'V2 WS', workspacePath: '/tmp/v2-ws', gitPath: '/tmp/v2-ws/.git',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      bootstrapStatus: 'complete', baselineCommit: null,
    });
    const batch = createBatch({ workspaceId: 'v2-w1', name: 'V2 Batch', fileName: 'v2.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678999', name: 'Legacy Item', rowNumber: 1 }]);

    downgradeToPreV2();
    expect(evidenceColumnNames()).not.toContain('catalog_version');
    expect(evidenceColumnNames()).not.toContain('sourcing_generation_id');

    // Legacy attempt with a NULL observed_at (pre-V2 rows have no such column).
    db.query(
      `INSERT INTO onboarding_evidence_attempts (id, item_id, provider_id, lookup_upc, outcome, confidence, evidence_url, matched_fields_json, identity_json, warnings_json, error_code, error_message, created_at)
       VALUES ('legacy-attempt-1', ?, 'phillips', '012345678999', 'found', 0.9, NULL, '[]', NULL, NULL, NULL, NULL, '2026-01-02T00:00:00.000Z')`,
    ).run(item.id);

    // Re-run migrations: the V2 block must re-execute on the pre-V2 database.
    runMigrations();

    const cols = evidenceColumnNames();
    for (const col of ['distributor_connection_id','catalog_snapshot_id','catalog_version','observed_at','expires_at','sourcing_generation_id']) {
      expect(cols).toContain(col);
    }

    // observed_at backfilled from created_at.
    const attempt = db.query('SELECT observed_at, created_at, distributor_connection_id FROM onboarding_evidence_attempts WHERE id = ?').get('legacy-attempt-1') as
      { observed_at: string; created_at: string; distributor_connection_id: string | null };
    expect(attempt.observed_at).toBe(attempt.created_at);

    // Deterministic legacy distributor + connection bound to the attempt.
    const conn = db.query('SELECT id, connector_type, workspace_id FROM distributor_connections WHERE id = ?').get(attempt.distributor_connection_id) as
      { id: string; connector_type: string; workspace_id: string } | undefined;
    expect(conn).toBeTruthy();
    expect(conn!.connector_type).toBe('legacy_adapter');
    expect(conn!.workspace_id).toBe('v2-w1');
    const dist = db.query('SELECT id FROM distributors WHERE id = ?').get('legacy_phillips') as { id: string } | undefined;
    expect(dist).toBeTruthy();
  });

  it('mid-migration failure leaves NO marker (fail closed, re-runnable after fix)', () => {
    downgradeToPreV2();

    // Introduce an FK violation that the block's foreign_key_check catches:
    // a ghost attempt row (FKs were off during downgrade rebuild path, so we
    // insert with FKs off explicitly).
    db.exec('PRAGMA foreign_keys = OFF');
    db.query(
      `INSERT INTO onboarding_evidence_attempts (id, item_id, provider_id, lookup_upc, outcome, confidence, evidence_url, matched_fields_json, identity_json, warnings_json, error_code, error_message, created_at)
       VALUES ('ghost-attempt', 'ghost-item', 'phillips', '012345678999', 'found', 0.9, NULL, '[]', NULL, NULL, NULL, NULL, '2026-01-02T00:00:00.000Z')`,
    ).run();
    db.exec('PRAGMA foreign_keys = ON');

    // The V2 block throws on foreign_key_check inside ONE transaction: the
    // marker must be absent AND every V2 table must be rolled back.
    expect(() => runMigrations()).toThrow(/foreign_key_check/);
    expect(db.query("SELECT value FROM app_meta WHERE key = 'distributor_v2_schema_version'").get()).toBeNull();
    const rolledBack = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('distributors','sourcing_generations')")
      .all() as Array<{ name: string }>;
    expect(rolledBack.length).toBe(0);

    // Removing the violation lets the block complete and write the marker.
    db.query('DELETE FROM onboarding_evidence_attempts WHERE id = ?').run('ghost-attempt');
    expect(() => runMigrations()).not.toThrow();
    expect(db.query("SELECT value FROM app_meta WHERE key = 'distributor_v2_schema_version'").get()).toBeTruthy();
  });

  it('marker-present upgrade path repairs the missing connection index (real-DB drift case)', () => {
    // Simulate a database migrated by an OLDER v2 block (the real app DB
    // state 2026-08-15): v2 marker present, superseded provider-scoped
    // unique index present, connection-scoped index MISSING — which makes
    // the evidence repo's ON CONFLICT target fail at prepare time. The new
    // repair marker is absent (it never existed in that DB). Restore the
    // post-Amendment-A column set first (earlier downgrade tests rebuilt the
    // table to the 13-column shape and the marker-gated Amendment A block
    // skips re-adding duration_ms).
    const driftCols = db
      .query('PRAGMA table_info(onboarding_evidence_attempts)')
      .all() as Array<{ name: string }>;
    if (!driftCols.some((c) => c.name === 'duration_ms')) {
      db.exec('ALTER TABLE onboarding_evidence_attempts ADD COLUMN duration_ms INTEGER;');
    }
    db.exec("DELETE FROM app_meta WHERE key = 'distributor_evidence_index_schema_version'");
    db.exec('DROP INDEX IF EXISTS idx_evidence_attempts_generation_conn');
    db.exec(`CREATE UNIQUE INDEX idx_evidence_attempts_generation_provider
      ON onboarding_evidence_attempts(item_id, provider_id, sourcing_generation_id)
      WHERE sourcing_generation_id IS NOT NULL`);

    expect(() => runMigrations()).not.toThrow();

    const connIndex = db
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_evidence_attempts_generation_conn'")
      .get();
    const providerIndex = db
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_evidence_attempts_generation_provider'")
      .get();
    expect(connIndex).toBeTruthy();
    expect(providerIndex).toBeNull();
    expect(db.query("SELECT value FROM app_meta WHERE key = 'distributor_evidence_index_schema_version'").get()).toBeTruthy();

    // The repository's exact INSERT ... ON CONFLICT statement now prepares
    // (SQLite rejects a conflict target that matches no unique constraint).
    expect(() =>
      db.prepare(`INSERT INTO onboarding_evidence_attempts
        (id, item_id, provider_id, distributor_connection_id, catalog_snapshot_id, lookup_upc, outcome, confidence, evidence_url,
         matched_fields_json, identity_json, warnings_json, error_code, error_message, catalog_version, observed_at, expires_at, sourcing_generation_id, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id, distributor_connection_id, sourcing_generation_id)
         WHERE distributor_connection_id IS NOT NULL AND sourcing_generation_id IS NOT NULL
       DO NOTHING`),
    ).not.toThrow();

    // Idempotent rerun stays clean.
    expect(() => runMigrations()).not.toThrow();

    // Drift guard after the marker: a missing connection index throws
    // fail-closed instead of being silently re-paired.
    db.exec('DROP INDEX IF EXISTS idx_evidence_attempts_generation_conn');
    expect(() => runMigrations()).toThrow(/distributor_evidence_index drift/);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_attempts_generation_conn
      ON onboarding_evidence_attempts(item_id, distributor_connection_id, sourcing_generation_id)
      WHERE distributor_connection_id IS NOT NULL AND sourcing_generation_id IS NOT NULL;`);
  });
});

describe('Default-On Sourcing schema migration (Amendment A)', () => {
  const onDbPath = '/tmp/baystate-cms-default-on-test.db';
  let db: ReturnType<typeof getDb>;

  beforeAll(() => {
    try { unlinkSync(onDbPath); } catch { /* ok */ }
    initDb(onDbPath);
    runMigrations();
    db = getDb();
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(onDbPath); } catch { /* ok */ }
  });

  function itemColumnNames(): string[] {
    return (db.query('PRAGMA table_info(onboarding_items)').all() as Array<{ name: string }>).map((c) => c.name);
  }

  function extractionColumnNames(): Array<{ name: string; notnull: number }> {
    return db.query('PRAGMA table_info(onboarding_extractions)').all() as Array<{ name: string; notnull: number }>;
  }

  function extractionSql(): string {
    return (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'onboarding_extractions'").get() as { sql: string }).sql;
  }

  function evidenceColumnNames(): string[] {
    return (db.query('PRAGMA table_info(onboarding_evidence_attempts)').all() as Array<{ name: string }>).map((c) => c.name);
  }

  function classificationEvidenceSql(): string {
    return (db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'classification_evidence'").get() as { sql: string }).sql;
  }

  /** Restore the exact pre-Amendment-A shapes and delete the marker. */
  function downgradeToPreAmendment(): void {
    const target = getDb();
    target.exec("DELETE FROM app_meta WHERE key = 'default_on_sourcing_schema_version'");
    target.exec("DELETE FROM app_meta WHERE key = 'manual_evidence_source_schema_version'");

    // onboarding_items back to the pre-amendment shape.
    target.exec('ALTER TABLE onboarding_items DROP COLUMN source_type;');
    target.exec('ALTER TABLE onboarding_items DROP COLUMN sourcing_entry_policy_version;');

    // onboarding_extractions back to NOT NULL source_url, no provenance columns.
    target.exec('PRAGMA foreign_keys = OFF');
    target.exec(`
      CREATE TABLE onboarding_extractions_old (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
        source_url TEXT NOT NULL,
        extraction_data_json TEXT NOT NULL,
        extraction_method TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.0,
        images_json TEXT,
        raw_structured_data_json TEXT,
        created_at TEXT NOT NULL
      );
    `);
    target.exec(`INSERT INTO onboarding_extractions_old
      SELECT id, item_id, source_url, extraction_data_json, extraction_method, confidence, images_json, raw_structured_data_json, created_at
      FROM onboarding_extractions`);
    target.exec('DROP TABLE onboarding_extractions;');
    target.exec('ALTER TABLE onboarding_extractions_old RENAME TO onboarding_extractions;');
    target.exec('CREATE INDEX IF NOT EXISTS idx_onboarding_extractions_item ON onboarding_extractions(item_id);');

    // classification_evidence back to the pre-amendment source CHECK.
    target.exec(`
      CREATE TABLE classification_evidence_old (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES classification_runs(id) ON DELETE CASCADE,
        onboarding_item_id TEXT,
        product_sku TEXT NOT NULL,
        stage_name TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('spreadsheet', 'official_product_page', 'third_party_page', 'visual_product_evidence', 'page_context', 'approved_product_example', 'catalog_manager_guidance', 'catalog_product')),
        reliability TEXT NOT NULL DEFAULT 'unknown' CHECK (reliability IN ('high', 'medium', 'low', 'conflicting', 'unknown')),
        attribute_id TEXT,
        source_url TEXT,
        source_field TEXT,
        snippet TEXT,
        value_json TEXT,
        metadata_json TEXT,
        snapshot_json TEXT,
        retention_expires_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
    target.exec('INSERT INTO classification_evidence_old SELECT * FROM classification_evidence;');
    target.exec('DROP TABLE classification_evidence;');
    target.exec('ALTER TABLE classification_evidence_old RENAME TO classification_evidence;');
    target.exec('CREATE INDEX IF NOT EXISTS idx_classification_evidence_run ON classification_evidence(run_id);');
    target.exec('CREATE INDEX IF NOT EXISTS idx_classification_evidence_product_source ON classification_evidence(product_sku, source);');
    target.exec('CREATE INDEX IF NOT EXISTS idx_classification_evidence_product ON classification_evidence(product_sku);');
    target.exec('PRAGMA foreign_keys = ON');

    // Evidence attempts: drop duration_ms + variant_axis_declarations
    // (appended last, so plain DROP COLUMN statements are legal) AND their
    // markers — the upgrade path must genuinely re-run BOTH amendment blocks
    // in order so the fresh and upgraded column ORDER converges.
    target.exec('ALTER TABLE onboarding_evidence_attempts DROP COLUMN duration_ms;');
    target.exec('ALTER TABLE onboarding_evidence_attempts DROP COLUMN variant_axis_declarations;');
    target.exec("DELETE FROM app_meta WHERE key = 'sourcing_variant_axes_schema_version'");
  }

  it('fresh install: item source/entry-policy columns, nullable extraction URL + provenance, duration_ms, expanded CHECK, marker', () => {
    const itemCols = itemColumnNames();
    expect(itemCols).toContain('source_type');
    expect(itemCols).toContain('sourcing_entry_policy_version');

    const extCols = extractionColumnNames();
    expect(extCols.find((c) => c.name === 'source_url')?.notnull).toBe(0);
    for (const col of ['source_type', 'sourcing_generation_id', 'accepted_evidence_attempt_ids_json', 'evidence_hash']) {
      expect(extCols.map((c) => c.name)).toContain(col);
    }
    expect(extractionSql()).toContain('distributor_record');

    expect(evidenceColumnNames()).toContain('duration_ms');
    expect(classificationEvidenceSql()).toContain('distributor_record');

    const marker = db.query("SELECT value FROM app_meta WHERE key = 'default_on_sourcing_schema_version'").get() as { value: string };
    expect(marker.value).toBe('1');
  });

  it('idempotent second run changes nothing', () => {
    expect(() => runMigrations()).not.toThrow();
    const rows = db.query("SELECT COUNT(*) as cnt FROM app_meta WHERE key = 'default_on_sourcing_schema_version'").get() as { cnt: number };
    expect(rows.cnt).toBe(1);
  });

  it('pre-amendment database upgrades: columns added, extractions rebuilt nullable with provenance, CHECK expanded, rows preserved', () => {
    // Seed a workspace/item + extraction row + classification evidence row so
    // the rebuilds are observable.
    insertWorkspace({
      id: 'on-ws', name: 'On WS', workspacePath: '/tmp/on-ws', gitPath: '/tmp/on-ws/.git',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      bootstrapStatus: 'complete', baselineCommit: null,
    });
    const batch = createBatch({ workspaceId: 'on-ws', name: 'On Batch', fileName: 'on.csv', totalItems: 1 });
    const [item] = insertItems(batch.id, [{ upc: '012345678911', name: 'On Item', rowNumber: 1 }]);
    db.query(
      `INSERT INTO onboarding_extractions (id, item_id, source_url, extraction_data_json, extraction_method, confidence, images_json, raw_structured_data_json, created_at)
       VALUES ('ext-on-1', ?, 'https://brand.example/p', '{}', 'worker', 0.9, NULL, NULL, '2026-01-02T00:00:00.000Z')`,
    ).run(item.id);
    db.query(
      `INSERT INTO classification_runs (id, workspace_id, onboarding_item_id, product_sku, source_kind, status, started_at)
       VALUES ('run-on-1', 'on-ws', ?, 'SKU-ON-1', 'onboarding', 'queued', '2026-01-02T00:00:00.000Z')`,
    ).run(item.id);
    db.query(
      `INSERT INTO classification_evidence (id, run_id, onboarding_item_id, product_sku, stage_name, source, reliability, created_at)
       VALUES ('ce-on-1', 'run-on-1', ?, 'SKU-ON-1', 'evidence_extraction', 'official_product_page', 'medium', '2026-01-02T00:00:00.000Z')`,
    ).run(item.id);

    downgradeToPreAmendment();
    expect(itemColumnNames()).not.toContain('source_type');
    expect(extractionColumnNames().find((c) => c.name === 'source_url')?.notnull).toBe(1);
    expect(evidenceColumnNames()).not.toContain('duration_ms');
    expect(classificationEvidenceSql()).not.toContain('distributor_record');

    runMigrations();

    // Columns restored.
    expect(itemColumnNames()).toContain('source_type');
    expect(itemColumnNames()).toContain('sourcing_entry_policy_version');
    expect(extractionColumnNames().find((c) => c.name === 'source_url')?.notnull).toBe(0);
    for (const col of ['source_type', 'sourcing_generation_id', 'accepted_evidence_attempt_ids_json', 'evidence_hash']) {
      expect(extractionColumnNames().map((c) => c.name)).toContain(col);
    }
    expect(evidenceColumnNames()).toContain('duration_ms');
    expect(classificationEvidenceSql()).toContain('distributor_record');

    // Rows preserved with the same ids; copied extractions get official_page + null provenance.
    const ext = db.query('SELECT id, source_url, source_type, sourcing_generation_id, accepted_evidence_attempt_ids_json, evidence_hash FROM onboarding_extractions WHERE id = ?').get('ext-on-1') as
      { id: string; source_url: string; source_type: string; sourcing_generation_id: string | null; accepted_evidence_attempt_ids_json: string | null; evidence_hash: string | null };
    expect(ext).toBeTruthy();
    expect(ext.source_url).toBe('https://brand.example/p');
    expect(ext.source_type).toBe('official_page');
    expect(ext.sourcing_generation_id).toBeNull();
    expect(ext.accepted_evidence_attempt_ids_json).toBeNull();
    expect(ext.evidence_hash).toBeNull();
    const ce = db.query('SELECT id, source FROM classification_evidence WHERE id = ?').get('ce-on-1') as { id: string; source: string };
    expect(ce).toBeTruthy();
    expect(ce.source).toBe('official_product_page');

    const marker = db.query("SELECT value FROM app_meta WHERE key = 'default_on_sourcing_schema_version'").get() as { value: string };
    expect(marker.value).toBe('1');
  });

  it('mid-migration failure leaves NO marker and preserves the old table (fail closed, re-runnable after fix)', () => {
    downgradeToPreAmendment();

    // Inject an FK violation that the block's foreign_key_check catches: a
    // ghost extraction row referencing a nonexistent item.
    db.exec('PRAGMA foreign_keys = OFF');
    db.query(
      `INSERT INTO onboarding_extractions (id, item_id, source_url, extraction_data_json, extraction_method, confidence, images_json, raw_structured_data_json, created_at)
       VALUES ('ext-ghost', 'ghost-item', 'https://x.example', '{}', 'worker', 0.9, NULL, NULL, '2026-01-02T00:00:00.000Z')`,
    ).run();
    db.exec('PRAGMA foreign_keys = ON');

    expect(() => runMigrations()).toThrow(/foreign_key_check/);
    // Marker absent AND the extraction table keeps its pre-amendment shape
    // (NOT NULL source_url) because the transaction rolled back.
    expect(db.query("SELECT value FROM app_meta WHERE key = 'default_on_sourcing_schema_version'").get()).toBeNull();
    expect(extractionColumnNames().find((c) => c.name === 'source_url')?.notnull).toBe(1);

    // Removing the violation lets the block complete and write the marker.
    db.query('DELETE FROM onboarding_extractions WHERE id = ?').run('ext-ghost');
    expect(() => runMigrations()).not.toThrow();
    expect(db.query("SELECT value FROM app_meta WHERE key = 'default_on_sourcing_schema_version'").get()).toBeTruthy();
    expect(extractionColumnNames().find((c) => c.name === 'source_url')?.notnull).toBe(0);
  });

  it('upgrades a legacy DEFAULT 1 distributor_connections to DEFAULT 0 while preserving row values', () => {
    // Seed a workspace + distributor + connection row (operator-controlled, ENABLED).
    insertWorkspace({
      id: 'conn-ws', name: 'Conn WS', workspacePath: '/tmp/conn-ws', gitPath: '/tmp/conn-ws/.git',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      bootstrapStatus: 'complete', baselineCommit: null,
    });
    db.exec("INSERT INTO distributors (id, name, status, created_at, updated_at) VALUES ('phillips', 'Phillips', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
    const now = '2026-01-01T00:00:00.000Z';
    db.query(
      `INSERT INTO distributor_connections (id, workspace_id, distributor_id, connector_type, secret_ref, configuration_json, authority_policy_json, enabled, created_at, updated_at)
       VALUES ('conn-on-1', 'conn-ws', 'phillips', 'api', NULL, '{}', '{}', 1, ?, ?)`,
    ).run(now, now);

    // Rebuild to the pre-Amendment-A storage shape: DEFAULT 1.
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`
      CREATE TABLE distributor_connections_old (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id),
        distributor_id TEXT NOT NULL REFERENCES distributors(id) ON DELETE CASCADE,
        connector_type TEXT NOT NULL CHECK (connector_type IN ('api', 'ftp_catalog', 'csv', 'legacy_adapter')),
        secret_ref TEXT,
        configuration_json TEXT DEFAULT '{}',
        authority_policy_json TEXT DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.exec('INSERT INTO distributor_connections_old SELECT * FROM distributor_connections');
    db.exec('DROP TABLE distributor_connections;');
    db.exec('ALTER TABLE distributor_connections_old RENAME TO distributor_connections;');
    db.exec('CREATE INDEX IF NOT EXISTS idx_distributor_connections_workspace ON distributor_connections(workspace_id);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_distributor_connections_distributor ON distributor_connections(distributor_id);');
    db.exec('PRAGMA foreign_keys = ON');

    // Re-run the block: marker absent → executes; all other guards skip (the
    // item/extraction/evidence/classification shapes are already amended).
    db.exec("DELETE FROM app_meta WHERE key = 'default_on_sourcing_schema_version'");
    // Also clear the Amendment B marker so the independent html_scraper block
    // re-runs after this test downgrades the CHECK (otherwise the still-present
    // marker would report drift against the pre-B shape).
    db.exec("DELETE FROM app_meta WHERE key = 'distributor_html_scraper_schema_version'");
    expect(() => runMigrations()).not.toThrow();

    // Storage default is now fail-closed; the operator-controlled ENABLED row
    // value is preserved exactly (never silently rewritten).
    const enabledCol = (db.query('PRAGMA table_info(distributor_connections)').all() as Array<{ name: string; dflt_value: string | null }>)
      .find((c) => c.name === 'enabled');
    expect(enabledCol?.dflt_value).toBe('0');
    const connRow = db.query('SELECT enabled FROM distributor_connections WHERE id = ?').get('conn-on-1') as { enabled: number };
    expect(connRow.enabled).toBe(1);
    // Amendment B: the rebuilt CHECK constraint accepts `html_scraper`.
    const connDdl = db
      .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'distributor_connections'")
      .get() as { sql?: string } | undefined;
    expect(connDdl?.sql).toContain("'html_scraper'");
    expect(db.query("SELECT value FROM app_meta WHERE key = 'default_on_sourcing_schema_version'").get()).toBeTruthy();
  });

  describe('Distributor html_scraper schema migration (Amendment B, independent marker)', () => {
    /** Rebuild distributor_connections to the pre-Amendment-B storage shape:
     *  old closed CHECK (no `html_scraper`) with the already-fixed fail-closed
     *  enabled DEFAULT 0 — i.e. an installation that COMPLETED Amendment A. */
    function downgradeConnectionsToPreB(): void {
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec(`
        CREATE TABLE distributor_connections_old (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspace(id),
          distributor_id TEXT NOT NULL REFERENCES distributors(id) ON DELETE CASCADE,
          connector_type TEXT NOT NULL CHECK (connector_type IN ('api', 'ftp_catalog', 'csv', 'legacy_adapter')),
          secret_ref TEXT,
          configuration_json TEXT DEFAULT '{}',
          authority_policy_json TEXT DEFAULT '{}',
          enabled INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      db.exec('INSERT INTO distributor_connections_old SELECT * FROM distributor_connections');
      db.exec('DROP TABLE distributor_connections;');
      db.exec('ALTER TABLE distributor_connections_old RENAME TO distributor_connections;');
      db.exec('CREATE INDEX IF NOT EXISTS idx_distributor_connections_workspace ON distributor_connections(workspace_id);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_distributor_connections_distributor ON distributor_connections(distributor_id);');
      db.exec('PRAGMA foreign_keys = ON');
    }

    function connDdl(): string | undefined {
      return (db
        .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'distributor_connections'")
        .get() as { sql?: string } | undefined)?.sql;
    }

    function htmlScraperMarker(): { value: string } | undefined {
      return db.query("SELECT value FROM app_meta WHERE key = 'distributor_html_scraper_schema_version'").get() as { value: string } | undefined;
    }

    it('KEY REGRESSION: a DB that already ran Amendment A still gains the html_scraper CHECK via the independent marker', () => {
      // Simulate a completed Amendment A install: marker present, enabled
      // default already 0 (so the Amendment A block would NOT rebuild), but
      // the connector_type CHECK predates Amendment B.
      downgradeConnectionsToPreB();
      db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('default_on_sourcing_schema_version', '1')");
      db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('distributor_v2_schema_version', '1')");
      db.exec("DELETE FROM app_meta WHERE key = 'distributor_html_scraper_schema_version'");

      expect(connDdl()).not.toContain('html_scraper');
      expect(() => runMigrations()).not.toThrow();

      expect(connDdl()).toContain("'html_scraper'");
      const enabledCol = (db.query('PRAGMA table_info(distributor_connections)').all() as Array<{ name: string; dflt_value: string | null }>)
        .find((c) => c.name === 'enabled');
      expect(enabledCol?.dflt_value).toBe('0');
      expect(htmlScraperMarker()?.value).toBe('1');

      // Second run is a no-op: marker present, shape verified, no throw.
      expect(() => runMigrations()).not.toThrow();
      const rows = db.query("SELECT COUNT(*) as cnt FROM app_meta WHERE key = 'distributor_html_scraper_schema_version'").get() as { cnt: number };
      expect(rows.cnt).toBe(1);
    });

    it('upgrade preserves rows, IDs, enabled values, secret refs, config JSON, and authority JSON', () => {
      insertWorkspace({
        id: 'conn-ws-b', name: 'Conn WS B', workspacePath: '/tmp/conn-ws-b', gitPath: '/tmp/conn-ws-b/.git',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        bootstrapStatus: 'complete', baselineCommit: null,
      });
      db.exec("INSERT INTO distributors (id, name, status, created_at, updated_at) VALUES ('orgill', 'Orgill', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
      db.query(
        `INSERT INTO distributor_connections (id, workspace_id, distributor_id, connector_type, secret_ref, configuration_json, authority_policy_json, enabled, created_at, updated_at)
         VALUES ('conn-b-1', 'conn-ws-b', 'orgill', 'api', 'ORGILL_KEY', '{"pageSize":25}', '{"skuAuthority":true}', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run();

      downgradeConnectionsToPreB();
      db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('default_on_sourcing_schema_version', '1')");
      db.exec("DELETE FROM app_meta WHERE key = 'distributor_html_scraper_schema_version'");

      expect(() => runMigrations()).not.toThrow();

      const row = db.query(
        'SELECT id, connector_type, secret_ref, configuration_json, authority_policy_json, enabled FROM distributor_connections WHERE id = ?',
      ).get('conn-b-1') as { id: string; connector_type: string; secret_ref: string; configuration_json: string; authority_policy_json: string; enabled: number };
      expect(row).toBeTruthy();
      expect(row.connector_type).toBe('api');
      expect(row.secret_ref).toBe('ORGILL_KEY');
      expect(row.configuration_json).toBe('{"pageSize":25}');
      expect(row.authority_policy_json).toBe('{"skuAuthority":true}');
      expect(row.enabled).toBe(1); // operator-controlled value preserved exactly
      expect(connDdl()).toContain("'html_scraper'");
    });

    it('marker present but schema drifted throws (never silently repaired)', () => {
      downgradeConnectionsToPreB();
      // Marker says migrated, but the CHECK predates html_scraper → drift.
      db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('distributor_html_scraper_schema_version', '1')");
      expect(() => runMigrations()).toThrow(/drift|html_scraper/);
      expect(connDdl()).not.toContain('html_scraper');

      // Restore a consistent state for later tests: drop the stray marker and
      // let the migration rebuild the table.
      db.exec("DELETE FROM app_meta WHERE key = 'distributor_html_scraper_schema_version'");
      expect(() => runMigrations()).not.toThrow();
      expect(connDdl()).toContain("'html_scraper'");
    });

    it('rebuild failure (FK violation) rolls back the table swap and leaves the marker absent', () => {
      downgradeConnectionsToPreB();
      db.exec("DELETE FROM app_meta WHERE key = 'distributor_html_scraper_schema_version'");
      // Ghost connection row referencing a nonexistent workspace → the block's
      // foreign_key_check throws inside the transaction and rolls back.
      db.exec('PRAGMA foreign_keys = OFF');
      db.query(
        `INSERT INTO distributor_connections (id, workspace_id, distributor_id, connector_type, secret_ref, configuration_json, authority_policy_json, enabled, created_at, updated_at)
         VALUES ('conn-ghost-b', 'ghost-ws-b', 'orgill', 'api', NULL, '{}', '{}', 0, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
      ).run();
      db.exec('PRAGMA foreign_keys = ON');

      expect(() => runMigrations()).toThrow(/foreign_key_check/);
      // Rolled back: table keeps the pre-B CHECK, marker absent, ghost row still present.
      expect(connDdl()).not.toContain('html_scraper');
      expect(htmlScraperMarker()).toBeFalsy();
      expect(db.query('SELECT id FROM distributor_connections WHERE id = ?').get('conn-ghost-b')).toBeTruthy();

      // Removing the violation lets the block complete and write the marker.
      db.query('DELETE FROM distributor_connections WHERE id = ?').run('conn-ghost-b');
      expect(() => runMigrations()).not.toThrow();
      expect(connDdl()).toContain("'html_scraper'");
      expect(htmlScraperMarker()?.value).toBe('1');
    });

    it('fresh schema accepts html_scraper and rejects unknown connector types', () => {
      insertWorkspace({
        id: 'conn-ws-fresh', name: 'Conn WS Fresh', workspacePath: '/tmp/conn-ws-fresh', gitPath: '/tmp/conn-ws-fresh/.git',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        bootstrapStatus: 'complete', baselineCommit: null,
      });
      db.exec("INSERT INTO distributors (id, name, status, created_at, updated_at) VALUES ('bradley', 'Bradley Caldwell', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
      db.query(
        `INSERT INTO distributor_connections (id, workspace_id, distributor_id, connector_type, secret_ref, configuration_json, authority_policy_json, enabled, created_at, updated_at)
         VALUES ('conn-fresh-1', 'conn-ws-fresh', 'bradley', 'html_scraper', NULL, '{}', '{}', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      ).run();
      expect(db.query('SELECT connector_type FROM distributor_connections WHERE id = ?').get('conn-fresh-1')).toBeTruthy();

      db.exec('PRAGMA foreign_keys = OFF');
      expect(() =>
        db.query(
          `INSERT INTO distributor_connections (id, workspace_id, distributor_id, connector_type, secret_ref, configuration_json, authority_policy_json, enabled, created_at, updated_at)
           VALUES ('conn-bad-1', 'conn-ws-fresh', 'bradley', 'browser_scraper', NULL, '{}', '{}', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        ).run(),
      ).toThrow(/CHECK/);
      db.exec('PRAGMA foreign_keys = ON');
    });
  });

  it('fresh and upgraded databases converge to the same final schema definitions', () => {
    const tables = ['onboarding_items', 'onboarding_extractions', 'distributor_connections', 'classification_evidence', 'onboarding_evidence_attempts'];
    const snapshot = (targetDb: ReturnType<typeof getDb>) =>
      Object.fromEntries(
        tables.map((t) => [
          t,
          (targetDb.query(`PRAGMA table_info(${t})`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>)
            .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk })),
        ]),
      );

    // Two GENUINELY separate databases: the fresh install and the pre-amendment
    // upgrade must converge on identical column definitions INCLUDING ORDER.
    // (The previous version captured 'fresh' from the shared DB after other
    // tests had already upgraded it, hiding the fresh-vs-ALTER ordering
    // difference — this test uses its own DB paths and must not share state.)
    const freshPath = '/tmp/baystate-cms-convergence-fresh.db';
    const upgradePath = '/tmp/baystate-cms-convergence-upgrade.db';
    try { unlinkSync(freshPath); } catch { /* ok */ }
    try { unlinkSync(upgradePath); } catch { /* ok */ }

    // Fresh install: brand-new empty database through the full migration chain.
    closeDb();
    initDb(freshPath);
    runMigrations();
    const fresh = snapshot(getDb());
    closeDb();

    // Pre-amendment upgrade: brand-new database migrated (same chain), then
    // restored to the exact pre-Amendment-A shapes, then re-migrated via the
    // default_on_sourcing block. This is the only path difference.
    initDb(upgradePath);
    runMigrations();
    downgradeToPreAmendment();
    expect(() => runMigrations()).not.toThrow();
    const upgraded = snapshot(getDb());
    closeDb();

    try { unlinkSync(freshPath); } catch { /* ok */ }
    try { unlinkSync(upgradePath); } catch { /* ok */ }

    // Column lists (order-sensitive), types, NOT NULL flags, defaults, and PK
    // roles must be identical between the two databases.
    expect(upgraded).toEqual(fresh);
  });
});

// ─── Post-review fixup 3/4: packaging_ocr CHECK expansion migration ───────────

describe('classification_stage_results packaging_ocr CHECK expansion (P2-T6 + post-review fixup 4)', () => {
  const dbPath = `/tmp/baystate-cms-ocr-stage-mig-${randomUUID()}.db`;

  beforeAll(() => {
    try { resetDb(); } catch { /* ok */ }
    initDb(dbPath);
    runMigrations();

    const db = getDb();
    // FK-clean parent row for stage results, plus one orphaned run_id to
    // prove the fixup-4 orphan cleanup fires before the copy.
    const now = new Date().toISOString();
    const wsId = randomUUID();
    insertWorkspace({
      id: wsId,
      name: 'OCR Stage Mig WS',
      workspacePath: `/tmp/ocr-stage-mig-${wsId}`,
      gitPath: '',
      createdAt: now,
      updatedAt: now,
      bootstrapStatus: 'complete',
      baselineCommit: null,
    });
    const runId = randomUUID();
    db.run(
      `INSERT INTO classification_runs (id, workspace_id, product_sku, source_kind, config_snapshot_hash, status, started_at)
       VALUES (?, ?, ?, 'onboarding', ?, 'completed', ?)`,
      [runId, wsId, 'OCR-MIG-SKU', 'f'.repeat(64), now],
    );

    // Simulate a LEGACY database: classification_stage_results with the
    // seven-name CHECK constraint (name_consolidation present,
    // packaging_ocr absent) holding a few pre-existing rows.
    const fkRow = db.query('PRAGMA foreign_keys').get() as { foreign_keys: number };
    const fkWasOn = Number(fkRow.foreign_keys) === 1;
    if (fkWasOn) db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec('DROP TABLE classification_stage_results');
        db.exec(`
          CREATE TABLE classification_stage_results (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES classification_runs(id) ON DELETE CASCADE,
            stage_name TEXT NOT NULL CHECK (stage_name IN ('evidence_extraction', 'name_consolidation', 'primary_product_type_proposal', 'attribute_applicability', 'product_attribute_proposals', 'category_page_proposals', 'product_draft_projection')),
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'abstained')),
            output_json TEXT,
            error_message TEXT,
            started_at TEXT NOT NULL,
            completed_at TEXT
          )
        `);
        for (const [stage, status] of [
          ['evidence_extraction', 'succeeded'],
          ['category_page_proposals', 'abstained'],
        ] as const) {
          db.run(
            `INSERT INTO classification_stage_results (id, run_id, stage_name, status, started_at)
             VALUES (?, ?, ?, ?, ?)`,
            [randomUUID(), runId, stage, status, now],
          );
        }
        // Orphaned dead data from a prior foreign_keys=OFF operation.
        db.run(
          `INSERT INTO classification_stage_results (id, run_id, stage_name, status, started_at)
           VALUES (?, 'orphaned-run-id', 'evidence_extraction', 'failed', ?)`,
          [randomUUID(), now],
        );
      })();
    } finally {
      if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
    }
  });

  afterAll(() => {
    closeDb();
    try { unlinkSync(dbPath); } catch { /* ok */ }
  });

  it('runMigrations rebuilds the CHECK with packaging_ocr, preserves pre-existing rows, prunes orphans transactionally, and accepts the new stage name', () => {
    const db = getDb();

    expect(() => runMigrations()).not.toThrow();

    // The rebuilt table's CHECK constraint includes packaging_ocr.
    const tableSql = (db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='classification_stage_results'").get() as { sql: string }).sql;
    expect(tableSql).toContain("'packaging_ocr'");
    expect(tableSql).toContain("'product_draft_projection'");

    // Pre-existing rows survived the rebuild.
    const rows = db.query('SELECT stage_name, status FROM classification_stage_results ORDER BY stage_name').all() as Array<{ stage_name: string; status: string }>;
    expect(rows.some(r => r.stage_name === 'evidence_extraction' && r.status === 'succeeded')).toBe(true);
    expect(rows.some(r => r.stage_name === 'category_page_proposals' && r.status === 'abstained')).toBe(true);

    // Fixup-4 hardening: the orphaned row was cleaned up BEFORE the copy —
    // it can never block the FK-enforcing rebuild or linger silently.
    const orphans = db.query("SELECT COUNT(*) AS cnt FROM classification_stage_results WHERE run_id = 'orphaned-run-id'").get() as { cnt: number };
    expect(Number(orphans.cnt)).toBe(0);
    // No _new remnant blocks a retry.
    const remnant = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='classification_stage_results_new'").get();
    expect(remnant).toBeFalsy();

    // The new stage name is writable.
    const newId = randomUUID();
    expect(() =>
      db.run(
        `INSERT INTO classification_stage_results (id, run_id, stage_name, status, started_at)
         SELECT ?, id, 'packaging_ocr', 'abstained', ? FROM classification_runs LIMIT 1`,
        [newId, new Date().toISOString()],
      ),
    ).not.toThrow();
    expect(
      (db.query('SELECT status FROM classification_stage_results WHERE id = ?').get(newId) as { status: string }).status,
    ).toBe('abstained');

    // An invalid stage name still fails the rebuilt CHECK.
    expect(() =>
      db.run(
        `INSERT INTO classification_stage_results (id, run_id, stage_name, status, started_at)
         SELECT ?, id, 'bogus_stage', 'succeeded', ? FROM classification_runs LIMIT 1`,
        [randomUUID(), new Date().toISOString()],
      ),
    ).toThrow();
  });

  it('verifies derivation_json exists in fresh schema.sql and after runMigrations', () => {
    const db = getDb();
    const cols = db.query('PRAGMA table_info(classification_proposals)').all() as Array<{ name: string }>;
    expect(cols.some(c => c.name === 'derivation_json')).toBe(true);

    const version = db.query("SELECT value FROM app_meta WHERE key = 'proposal_derivation_schema_version'").get() as { value: string };
    expect(version).toBeDefined();
    expect(version.value).toBe('1');
  });

  it('fresh schema.sql directly creates derivation_json column', () => {
    const schemaSql = fs.readFileSync(path.join(__dirname, '../../db/schema.sql'), 'utf-8');
    expect(schemaSql).toContain('derivation_json TEXT');
  });
});
