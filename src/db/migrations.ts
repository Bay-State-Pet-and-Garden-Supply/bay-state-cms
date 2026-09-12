import { getDb } from './connection';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { sha256Hex } from '../shared/stable-id';

const SCHEMA_PATH = path.resolve(import.meta.dirname, 'schema.sql');
const ONBOARDING_MIGRATION_PATH = path.resolve(import.meta.dirname, 'onboarding-migration.sql');
const CLASSIFICATION_MIGRATION_PATH = path.resolve(import.meta.dirname, 'classification-migration.sql');
const STAGE_PIPELINE_MIGRATION_PATH = path.resolve(import.meta.dirname, 'stage-pipeline-migration.sql');
const COHORT_MIGRATION_PATH = path.resolve(import.meta.dirname, 'cohort-migration.sql');
const DISTRIBUTOR_V2_MIGRATION_PATH = path.resolve(import.meta.dirname, 'distributor-v2-migration.sql');
const BRAND_STRATEGY_MIGRATION_PATH = path.resolve(import.meta.dirname, 'brand-strategy-migration.sql');
const BRAND_STRATEGY_BUILDER_MIGRATION_PATH = path.resolve(import.meta.dirname, 'brand-strategy-builder-migration.sql');
const BRAND_ADVISORY_RETIREMENT_MIGRATION_PATH = path.resolve(import.meta.dirname, 'brand-advisory-retirement-migration.sql');
const STRATEGY_COLLECTION_RESULT_MIGRATION_PATH = path.resolve(import.meta.dirname, 'strategy-collection-result-migration.sql');
const OPERATOR_STATE_MIGRATION_PATH = path.resolve(import.meta.dirname, 'operator-state-migration.sql');

/**
 * Manual-evidence boot-time invariant verification (parent #101, ticket
 * #105 hardening). Fail boot on violation, never silently repair. Called
 * by the foundation migration and exported so the hardening suite can pin
 * each violation class on fixtures. Accepts any bun:sqlite handle.
 */
export function verifyManualEvidenceInvariants(db: ReturnType<typeof getDb>): void {
  // 1) source_type vocabulary unchanged (two-valued). Parsed from the
  //    stored DDL so historical spacing variants cannot false-positive.
  const extDdl = db
    .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'onboarding_extractions'")
    .get() as { sql?: string } | undefined;
  const vocabMatch = extDdl?.sql?.match(/CHECK\s*\(\s*source_type\s+IN\s*\(([^)]+)\)/);
  const vocabValues = vocabMatch
    ? vocabMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).sort()
    : null;
  if (vocabValues && JSON.stringify(vocabValues) !== JSON.stringify(['distributor_record', 'official_page'])) {
    throw new Error('[Migrations] onboarding_extractions source_type vocabulary changed — manual-evidence plan §2 reversal required');
  }
  // 2) No manual-method row may carry a source URL, a sourcing
  //    generation, or a non-official source type (never a fake URL).
  const badManual = db.query(`
    SELECT COUNT(*) AS cnt FROM onboarding_extractions
    WHERE extraction_method = 'manual_evidence_v1'
      AND (source_url IS NOT NULL
        OR sourcing_generation_id IS NOT NULL
        OR source_type != 'official_page'
        OR manual_attestation_id IS NULL)
  `).get() as { cnt: number };
  if (badManual.cnt > 0) {
    throw new Error('[Migrations] manual_evidence_v1 rows violate NULL-URL/official-page/attestation invariant');
  }
  // 3) Attestation checklist/value-hash columns must be non-empty JSON
  //    objects on every row.
  const badAtt = db.query(`
    SELECT COUNT(*) AS cnt FROM onboarding_manual_evidence_attestations
    WHERE field_checklist_json IS NULL OR value_hashes_json IS NULL
      OR field_checklist_json = '' OR value_hashes_json = ''
  `).get() as { cnt: number };
  if (badAtt.cnt > 0) {
    throw new Error('[Migrations] onboarding_manual_evidence_attestations has rows with empty checklist/hash JSON');
  }
  // 4) v2 row classes (ticket #104 columns, ticket #105 review P1-1):
  //    stored image-rights JSON must parse as a bounded array; the
  //    family-reference text snapshot must fit its bound. NULL means the
  //    row predates v2 (never backfilled) and is always acceptable. The
  //    whole class is skipped when the v2 columns do not exist yet (v1
  //    databases verify classes 1–3 only).
  const attCols = (db.query('PRAGMA table_info(onboarding_manual_evidence_attestations)').all() as Array<{ name: string }>).map((c) => c.name);
  if (!attCols.includes('image_rights_json') || !attCols.includes('family_reference_text')) {
    return;
  }
  const badRights = db.query(`
    SELECT COUNT(*) AS cnt FROM onboarding_manual_evidence_attestations
    WHERE image_rights_json IS NOT NULL
      AND (json_valid(image_rights_json) != 1
        OR json_type(image_rights_json) != 'array'
        OR length(image_rights_json) > 20000)
  `).get() as { cnt: number };
  if (badRights.cnt > 0) {
    throw new Error('[Migrations] onboarding_manual_evidence_attestations has rows with invalid image_rights_json');
  }
  const badSnapshot = db.query(`
    SELECT COUNT(*) AS cnt FROM onboarding_manual_evidence_attestations
    WHERE family_reference_text IS NOT NULL AND length(family_reference_text) > 8000
  `).get() as { cnt: number };
  if (badSnapshot.cnt > 0) {
    throw new Error('[Migrations] onboarding_manual_evidence_attestations has rows with oversized family_reference_text');
  }
}

export function runMigrations(): void {
  const db = getDb();
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  try {
    db.exec(sql);
  } catch (_e) {
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      try {
        db.exec(stmt);
      } catch (stmtErr) {
        console.warn('[Migrations] Initial schema statement deferred:', stmtErr);
      }
    }
  }

  // Run onboarding migration if not already applied
  const onboardingVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('onboarding_schema_version') as
    | { value: string }
    | undefined;
  if (!onboardingVersion) {
    const onboardingSql = fs.readFileSync(ONBOARDING_MIGRATION_PATH, 'utf-8');
    db.exec(onboardingSql);
    db.exec("INSERT INTO app_meta (key, value) VALUES ('onboarding_schema_version', '1');");
  }

  // ── Discovery run traceability (epic #46 batch-analysis follow-up) ──
  // The `onboarding_discovery_runs` table + `onboarding_sources.discovery_run_id`
  // existed in older live databases but were NEVER created by any migration
  // in this codebase and never written by code — an unfinished design from a
  // superseded discovery path (fresh installs lacked the table entirely;
  // every source row had a NULL run id). This migration recreates the
  // original schema (same columns/CHECKs as the legacy live-DB shape) so
  // the current discovery flow can persist run-level traces. Additive +
  // idempotent: `CREATE TABLE IF NOT EXISTS` + guarded `ALTER TABLE`.
  const discoveryRunsVersion = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get('onboarding_discovery_runs_schema_version') as { value: string } | undefined;
  if (!discoveryRunsVersion) {
    console.log('[Migrations] Running onboarding discovery-runs traceability migration...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS onboarding_discovery_runs (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL CHECK(trigger IN ('automatic', 'refinement', 'direct_url')),
        status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'completed', 'failed')),
        request_json TEXT NOT NULL,
        current_step TEXT CHECK(current_step IN (
          'preflight', 'sitemap_fetch', 'sitemap_match', 'official_search',
          'identifier_search', 'name_consolidation', 'name_search',
          'variant_resolution', 'page_verification', 'ranking', 'applying_outcome'
        )),
        outcome TEXT CHECK(outcome IN (
          'auto_selected', 'needs_input_candidates', 'needs_input_no_candidates',
          'needs_input_ambiguous', 'needs_input_setup', 'failed'
        )),
        outcome_message TEXT,
        claim_token TEXT,
        claimed_at TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        retry_request_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );
    `);
    const sourceCols = db.query('PRAGMA table_info(onboarding_sources)').all() as Array<{ name: string }>;
    if (!sourceCols.some(col => col.name === 'discovery_run_id')) {
      db.exec('ALTER TABLE onboarding_sources ADD COLUMN discovery_run_id TEXT NULL;');
    }
    db.exec("INSERT INTO app_meta (key, value) VALUES ('onboarding_discovery_runs_schema_version', '1');");
    console.log('[Migrations] Onboarding discovery-runs traceability migration complete.');
  }

  // v2: restore the one-active-run-per-item invariant. Legacy live databases
  // carried unique partial indexes `idx_discovery_runs_one_running` /
  // `idx_discovery_runs_one_queued` (at most one 'running' and one 'queued'
  // run per item), but the v1 schema above omitted them — fresh installs had
  // no guard and the current code assumes a single active run per item. The
  // repository's `createDiscoveryRun` supersedes stale active runs before
  // inserting, so the indexes are a safe backstop against concurrent
  // executions, never a retry blocker. `IF NOT EXISTS` leaves the legacy
  // originals untouched on databases that still carry them.
  const discoveryRunsV2 = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get('onboarding_discovery_runs_schema_version') as { value: string } | undefined;
  if (discoveryRunsV2?.value !== '2') {
    console.log('[Migrations] Restoring discovery-runs one-active-run-per-item indexes...');
    // Legacy databases could already contain duplicate queued/running rows
    // because v1 did not enforce the invariant. Clean those rows before
    // creating the unique partial indexes; otherwise CREATE UNIQUE INDEX
    // aborts startup before the migration can repair the state.
    db.transaction(() => {
      db.exec(`
        UPDATE onboarding_discovery_runs AS stale
        SET status = 'failed',
            outcome = 'failed',
            outcome_message = 'Superseded during discovery-runs index migration',
            completed_at = COALESCE(completed_at, datetime('now')),
            claim_token = NULL,
            claimed_at = NULL
        WHERE stale.status IN ('queued', 'running')
          AND EXISTS (
            SELECT 1
            FROM onboarding_discovery_runs AS newer
            WHERE newer.item_id = stale.item_id
              AND newer.status = stale.status
              AND (
                newer.created_at > stale.created_at
                OR (newer.created_at = stale.created_at AND newer.rowid > stale.rowid)
              )
          );
      `);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_runs_one_running
          ON onboarding_discovery_runs(item_id) WHERE status = 'running';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_discovery_runs_one_queued
          ON onboarding_discovery_runs(item_id) WHERE status = 'queued';
      `);
      db.exec(`
        INSERT INTO app_meta (key, value) VALUES ('onboarding_discovery_runs_schema_version', '2')
        ON CONFLICT(key) DO UPDATE SET value = '2';
      `);
    })();
    console.log('[Migrations] Discovery-runs indexes complete.');
  }

  // ── Epic #46 operator work-state: durable review/approval/export state ──
  // New table `onboarding_review_state` (version-gated marker
  // `operator_state_schema_version`). Runs AFTER the onboarding migration
  // (the legacy backfill below reads onboarding_items). Additive +
  // idempotent: fresh installs and existing databases converge on the same
  // shape. The backfill migrates already-reviewed legacy items (review
  // completed, or advanced to promotion) into durable reviewed state once.
  const operatorStateVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('operator_state_schema_version') as
    | { value: string }
    | undefined;
  if (!operatorStateVersion) {
    const operatorStateSql = fs.readFileSync(OPERATOR_STATE_MIGRATION_PATH, 'utf-8');
    db.exec(operatorStateSql);
    // Legacy backfill: existing reviewed items (review completed, or already
    // promoted) become durable reviewed state once. Guarded on the `stage`
    // column: on a truly fresh DB the stage-pipeline migration (which adds
    // it) runs LATER in this file, and a fresh DB has no legacy items anyway.
    const itemCols = db.query('PRAGMA table_info(onboarding_items)').all() as Array<{ name: string }>;
    const hasStageColumns = itemCols.some(col => col.name === 'stage');
    if (hasStageColumns) {
      try {
        db.exec(`
          INSERT OR IGNORE INTO onboarding_review_state
            (item_id, batch_id, reviewed_at, reviewed_by, review_invalidated_at, review_invalidation_reason,
             approved_at, approved_by, approval_origin, created_at, updated_at)
          SELECT i.id, i.batch_id, i.updated_at, 'legacy', NULL, NULL,
                 CASE WHEN i.stage = 'promotion' THEN i.updated_at ELSE NULL END,
                 CASE WHEN i.stage = 'promotion' THEN 'legacy' ELSE NULL END,
                 'legacy', i.updated_at, i.updated_at
          FROM onboarding_items i
          WHERE (i.stage = 'review' AND i.stage_status = 'completed') OR i.stage = 'promotion'
        `);

        // v1 → v2 (epic #46 audit fix): legacy promotion-stage items — whose
        // historical Promote action WAS the release decision under the old
        // model — receive durable APPROVAL (origin 'legacy'). Without this
        // backfill the new promote gate would strand pre-epic released
        // batches (approved_at stays NULL for them). Fresh installs write the
        // approval directly above and converge here as a no-op.
        db.exec(`
          UPDATE onboarding_review_state
          SET approved_at = COALESCE(approved_at, updated_at),
              approved_by = COALESCE(approved_by, 'legacy'),
              updated_at = updated_at
          WHERE review_invalidated_at IS NULL
            AND item_id IN (SELECT id FROM onboarding_items WHERE stage = 'promotion')
        `);
      } catch (e) {
        console.error('[Migrations] operator_state backfill failed (non-fatal):', e);
      }
    }
    db.exec("INSERT INTO app_meta (key, value) VALUES ('operator_state_schema_version', '1');");
    console.log('[Migrations] operator_state_schema_version initialized to 1.');
  }

  // v1 → v2 hop (epic #46 audit fix): legacy promotion-stage items receive
  // durable APPROVAL so the new promote gate never strands pre-epic released
  // batches. Runs only for a marker-'1' database; already-converged rows are
  // untouched (COALESCE keeps existing approved_at).
  //
  // Idempotency/correctness: the marker is advanced to '2' ONLY when the
  // UPDATE actually applied. On an old-schema DB where the stage-pipeline
  // migration (which adds `onboarding_items.stage`) runs LATER in this file,
  // the hop is skipped and the marker stays '1' so the backfill runs on the
  // next boot once `stage` exists — it is never permanently skipped by a
  // transient failure.
  const operatorStateV1 = db.query('SELECT value FROM app_meta WHERE key = ?').get('operator_state_schema_version') as
    | { value: string }
    | undefined;
  if (operatorStateV1 && operatorStateV1.value === '1') {
    const v2Cols = db.query('PRAGMA table_info(onboarding_items)').all() as Array<{ name: string }>;
    const hasStageColumn = v2Cols.some(col => col.name === 'stage');
    let applied = false;
    if (hasStageColumn) {
      try {
        db.exec(`
          UPDATE onboarding_review_state
          SET approved_at = COALESCE(approved_at, updated_at),
              approved_by = COALESCE(approved_by, 'legacy'),
              updated_at = updated_at
          WHERE review_invalidated_at IS NULL
            AND item_id IN (SELECT id FROM onboarding_items WHERE stage = 'promotion')
        `);
        applied = true;
      } catch (e) {
        console.error('[Migrations] operator_state promotion-approval backfill failed (non-fatal; marker retained for retry):', e);
      }
    }
    if (applied) {
      db.exec("INSERT INTO app_meta (key, value) VALUES ('operator_state_schema_version', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value;");
      console.log('[Migrations] operator_state_schema_version advanced to 2 (legacy promotion approval backfill).');
    }
  }

  // Ensure field_registry has curated_fields_json column (issue #31 commit 1).
  // Records which properties were curated by an operator through the canonical
  // field-metadata service (e.g. ["label","uiGroup"]). Sync merges
  // per-property and never clobbers curated metadata. NULL = never curated
  // (sync defaults apply). Outside the version gate: new nullable column, safe
  // for existing databases, PRAGMA table_info guarded for idempotency.
  try {
    const frCols = db.query('PRAGMA table_info(field_registry)').all() as Array<{ name: string }>;
    if (frCols.length > 0 && !frCols.some(col => col.name === 'curated_fields_json')) {
      db.exec('ALTER TABLE field_registry ADD COLUMN curated_fields_json TEXT;');
      console.log('[Migrations] Added curated_fields_json column to field_registry.');
    }
  } catch (e) {
    console.error('[Migrations] Failed to add curated_fields_json column:', e);
  }

  // ── D4 (issue #31 commit 3): mapping-validity findings ───────────────────
  //
  // Sync (catalog pulls) records per-mapping Catalog Field presence here. The
  // sync writer is intentionally limited to findings and NEVER writes isStale
  // on attributeMappings — isStale is mapping-authority state. A future
  // canonical classification-config reconciliation operation (mapping
  // editor/activation path) reads these findings and writes isStale through
  // the same authority path as every other mapping mutation. Outside the
  // version gate: new table, safe for existing databases, idempotent.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mapping_validity_findings (
        workspace_id TEXT NOT NULL,
        catalog_field TEXT NOT NULL,
        field_present INTEGER NOT NULL,
        detected_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, catalog_field)
      );
    `);
  } catch (e) {
    console.error('[Migrations] Failed to create mapping_validity_findings table:', e);
  }

  // ── AI Compute & Provider Connections ─────────────────────────────────────
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_connections (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        transport TEXT NOT NULL DEFAULT 'openai-compatible',
        base_url TEXT NOT NULL,
        credential TEXT,
        trust_zone TEXT NOT NULL DEFAULT 'this_device',
        approved_host TEXT NOT NULL,
        approved_port INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        connect_timeout_ms INTEGER NOT NULL DEFAULT 2000,
        inference_timeout_ms INTEGER NOT NULL DEFAULT 60000,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_workload_routes (
        workload TEXT PRIMARY KEY,
        primary_connection_id TEXT NOT NULL,
        primary_model_id TEXT NOT NULL,
        fallback_connection_id TEXT,
        fallback_model_id TEXT,
        text_data_sharing TEXT,
        image_data_sharing TEXT,
        terminal_behavior TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_routing_defaults (
        id TEXT PRIMARY KEY DEFAULT 'current',
        catalog_primary_connection_id TEXT NOT NULL,
        catalog_primary_model_id TEXT NOT NULL,
        catalog_fallback_connection_id TEXT,
        catalog_fallback_model_id TEXT,
        text_data_sharing TEXT NOT NULL DEFAULT 'cloud_allowed',
        image_data_sharing TEXT NOT NULL DEFAULT 'trusted_lan_allowed',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  } catch (e) {
    console.error('[Migrations] Failed to create provider_connections / ai_workload_routes / ai_routing_defaults tables:', e);
  }


  // Ensure product_index has parent_sku and search columns (migration support for existing databases)
  try {
    const columns = db.query('PRAGMA table_info(product_index)').all() as Array<{ name: string }>;
    if (!columns.some(col => col.name === 'parent_sku')) {
      db.exec('ALTER TABLE product_index ADD COLUMN parent_sku TEXT REFERENCES product_index(sku);');
    }
    if (!columns.some(col => col.name === 'description')) {
      db.exec('ALTER TABLE product_index ADD COLUMN description TEXT;');
    }
    if (!columns.some(col => col.name === 'search_keywords')) {
      db.exec('ALTER TABLE product_index ADD COLUMN search_keywords TEXT;');
    }
    if (!columns.some(col => col.name === 'custom_fields')) {
      db.exec('ALTER TABLE product_index ADD COLUMN custom_fields TEXT;');
    }
  } catch (e) {
    console.error('Failed to update product_index columns:', e);
  }

  // Ensure onboarding_items table has curation_data_json and expected_name columns
  try {
    const columns = db.query('PRAGMA table_info(onboarding_items)').all() as Array<{ name: string }>;
    if (columns.length > 0 && !columns.some(col => col.name === 'curation_data_json')) {
      db.exec('ALTER TABLE onboarding_items ADD COLUMN curation_data_json TEXT;');
    }
    if (columns.length > 0 && !columns.some(col => col.name === 'expected_name')) {
      db.exec('ALTER TABLE onboarding_items ADD COLUMN expected_name TEXT;');
    }
    if (columns.length > 0 && !columns.some(col => col.name === 'coordinated_title')) {
      db.exec('ALTER TABLE onboarding_items ADD COLUMN coordinated_title TEXT;');
    }
  } catch (e) {
    console.error('Failed to update onboarding_items columns:', e);
  }

  // Ensure extractor_profiles table exists
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS extractor_profiles (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL UNIQUE,
        title_selector TEXT,
        price_selector TEXT,
        description_selector TEXT,
        brand_selector TEXT,
        images_selector TEXT,
        sitemap_product_url_pattern TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_extractor_profiles_domain ON extractor_profiles(domain);
    `);
  } catch (e) {
    console.error('Failed to create extractor_profiles table:', e);
  }

  // Ensure extractor_profiles has sitemap_product_url_pattern column (migration
  // support for existing databases created before the column was added).
  try {
    const columns = db.query('PRAGMA table_info(extractor_profiles)').all() as Array<{ name: string }>;
    if (columns.length > 0 && !columns.some(col => col.name === 'sitemap_product_url_pattern')) {
      db.exec('ALTER TABLE extractor_profiles ADD COLUMN sitemap_product_url_pattern TEXT;');
    }
  } catch (e) {
    console.error('Failed to update extractor_profiles columns:', e);
  }

  // Ensure extractor_profiles has shopify_json_path column
  try {
    const cols = db.query('PRAGMA table_info(extractor_profiles)').all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some(col => col.name === 'shopify_json_path')) {
      db.exec('ALTER TABLE extractor_profiles ADD COLUMN shopify_json_path INTEGER NOT NULL DEFAULT 0;');
    }
  } catch (e) {
    console.error('Failed to update extractor_profiles columns:', e);
  }

  // Ensure extractor_profiles has custom_selectors_json column
  try {
    const cols = db.query('PRAGMA table_info(extractor_profiles)').all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some(col => col.name === 'custom_selectors_json')) {
      db.exec("ALTER TABLE extractor_profiles ADD COLUMN custom_selectors_json TEXT DEFAULT '{}';");
    }
  } catch (e) {
    console.error('Failed to update extractor_profiles columns:', e);
  }

  // Ensure extractor_profiles has title_optional_selectors_json column
  try {
    const cols = db.query('PRAGMA table_info(extractor_profiles)').all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some(col => col.name === 'title_optional_selectors_json')) {
      db.exec("ALTER TABLE extractor_profiles ADD COLUMN title_optional_selectors_json TEXT DEFAULT '[]';");
      console.log('[Migrations] Added title_optional_selectors_json column to extractor_profiles.');
    }
  } catch (e) {
    console.error('[Migrations] Failed to add title_optional_selectors_json column:', e);
  }

  // Ensure extractor_profiles has variant_selection_strategy_json column
  try {
    const cols = db.query('PRAGMA table_info(extractor_profiles)').all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some(col => col.name === 'variant_selection_strategy_json')) {
      db.exec('ALTER TABLE extractor_profiles ADD COLUMN variant_selection_strategy_json TEXT;');
      console.log('[Migrations] Added variant_selection_strategy_json column to extractor_profiles.');
    }
  } catch (e) {
    console.error('[Migrations] Failed to add variant_selection_strategy_json column:', e);
  }

  // Ensure extractor_profiles has custom_selector_metadata_json column
  try {
    const cols = db.query('PRAGMA table_info(extractor_profiles)').all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some(col => col.name === 'custom_selector_metadata_json')) {
      db.exec("ALTER TABLE extractor_profiles ADD COLUMN custom_selector_metadata_json TEXT DEFAULT '{}';");
      console.log('[Migrations] Added custom_selector_metadata_json column to extractor_profiles.');
    }
  } catch (e) {
    console.error('[Migrations] Failed to add custom_selector_metadata_json column:', e);
  }

  // Ensure extractor_profiles has runtime column
  try {
    const cols = db.query('PRAGMA table_info(extractor_profiles)').all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some(col => col.name === 'runtime')) {
      db.exec("ALTER TABLE extractor_profiles ADD COLUMN runtime TEXT NOT NULL DEFAULT 'rendered';");
      console.log('[Migrations] Added runtime column to extractor_profiles.');
    }
  } catch (e) {
    console.error('[Migrations] Failed to add runtime column:', e);
  }

  // e07s01: transactional immutable profile versions (replaces in-memory Maps)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile_versions (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        version INTEGER NOT NULL,
        selectors TEXT NOT NULL,
        runtime TEXT NOT NULL,
        sample_ids TEXT NOT NULL,
        artifact_hashes TEXT NOT NULL,
        validation_summary TEXT NOT NULL,
        provenance TEXT NOT NULL,
        approver TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(domain, version)
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_profile_versions_domain ON profile_versions(domain);`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile_active (
        domain TEXT PRIMARY KEY,
        active_version_id TEXT REFERENCES profile_versions(id) ON DELETE SET NULL
      );
    `);
  } catch (e) {
    console.error('[Migrations] Failed to create profile_versions / profile_active tables:', e);
  }

  // e07s02: cluster overrides (operator merge/split persistence)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cluster_overrides (
        domain TEXT NOT NULL,
        cluster_key TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (domain, cluster_key)
      );
    `);
    // Repair legacy schema with camelCase columns (clusterKey/at) from early e07 migration
    const cols = db.query("PRAGMA table_info(cluster_overrides)").all() as Array<{ name: string }>;
    const hasClusterKey = cols.some(c => c.name === 'clusterKey');
    const hasAt = cols.some(c => c.name === 'at');
    if (hasClusterKey || hasAt) {
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.transaction(() => {
          db.exec(`
            CREATE TABLE IF NOT EXISTS cluster_overrides_new (
              domain TEXT NOT NULL,
              cluster_key TEXT NOT NULL,
              action TEXT NOT NULL,
              actor TEXT NOT NULL,
              created_at TEXT NOT NULL,
              PRIMARY KEY (domain, cluster_key)
            )
          `);
          const hasOldClusterKey = cols.some(c => c.name === 'clusterKey');
          const hasOldAt = cols.some(c => c.name === 'at');
          // Copy: map old columns to new names (both schemas may coexist transiently)
          if (hasOldClusterKey && hasOldAt) {
            db.exec(`INSERT OR IGNORE INTO cluster_overrides_new (domain, cluster_key, action, actor, created_at)
                     SELECT domain, clusterKey, action, actor, at FROM cluster_overrides`);
          } else if (hasOldClusterKey) {
            db.exec(`INSERT OR IGNORE INTO cluster_overrides_new (domain, cluster_key, action, actor, created_at)
                     SELECT domain, clusterKey, action, actor, created_at FROM cluster_overrides`);
          } else if (hasOldAt) {
            db.exec(`INSERT OR IGNORE INTO cluster_overrides_new (domain, cluster_key, action, actor, created_at)
                     SELECT domain, cluster_key, action, actor, at FROM cluster_overrides`);
          }
          db.exec('DROP TABLE cluster_overrides');
          db.exec('ALTER TABLE cluster_overrides_new RENAME TO cluster_overrides');
        })();
        const fk = db.query("PRAGMA foreign_key_check('cluster_overrides')").all();
        if (fk.length > 0) console.warn('[Migrations] FK violations after cluster_overrides repair:', fk.slice(0,3));
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    }
  } catch (e) {
    console.error('[Migrations] Failed to create cluster_overrides table:', e);
  }

  // e07s01 seed: legacy extractor_profiles → profile_versions v1 (idempotent, degraded)
  // story: e07s01 — do NOT set active; legacy remains Degraded until re-pass
  try {
    const hasExtractor = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='extractor_profiles'").get() as { name: string } | undefined;
    if (hasExtractor) {
      const legacyRows = db.query('SELECT domain, title_selector, price_selector, description_selector, brand_selector, images_selector, sitemap_product_url_pattern, custom_selectors_json, runtime FROM extractor_profiles').all() as Array<{
        domain: string; title_selector: string | null; price_selector: string | null; description_selector: string | null; brand_selector: string | null; images_selector: string | null; sitemap_product_url_pattern: string | null; custom_selectors_json: string | null; runtime: string | null;
      }>;
      for (const r of legacyRows) {
        const domain = (r.domain ?? '').toLowerCase().replace(/^www\./, '').trim();
        if (!domain) continue;
        const existing = db.query('SELECT COUNT(*) as c FROM profile_versions WHERE domain = ?').get(domain) as { c: number } | undefined;
        if ((existing?.c ?? 0) > 0) continue;
        const selectors: Record<string, unknown> = {};
        if (r.title_selector) selectors['title_selector'] = r.title_selector;
        if (r.price_selector) selectors['price_selector'] = r.price_selector;
        if (r.description_selector) selectors['description_selector'] = r.description_selector;
        if (r.brand_selector) selectors['brand_selector'] = r.brand_selector;
        if (r.images_selector) selectors['images_selector'] = r.images_selector;
        if (r.sitemap_product_url_pattern) selectors['sitemap_product_url_pattern'] = r.sitemap_product_url_pattern;
        try { const cs = r.custom_selectors_json ? JSON.parse(r.custom_selectors_json) : {}; if (cs && typeof cs === 'object') Object.assign(selectors, cs); } catch { /* ignore malformed */ }
        const id = randomUUID();
        const now = new Date().toISOString();
        db.query('INSERT INTO profile_versions (id, domain, version, selectors, runtime, sample_ids, artifact_hashes, validation_summary, provenance, approver, reason, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          id,
          domain,
          JSON.stringify(selectors),
          r.runtime ?? 'rendered',
          JSON.stringify([]),
          JSON.stringify([]),
          JSON.stringify({ legacy: true }),
          JSON.stringify({ provider: 'legacy-migration', model: 'migrate', configId: 'legacy' }),
          'system',
          'legacy-migration',
          now,
        );
        console.log(`[Migrations] Seeded legacy profile_versions v1 for ${domain}`);
      }
    }
  } catch (e) {
    console.error('[Migrations] Failed to seed legacy profile_versions (non-fatal):', e);
  }

  // e08 Test slice: durable profile matrix runs (replaces in-memory Map)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile_matrix_runs (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        version_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        artifact_hashes TEXT NOT NULL
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_profile_matrix_runs_domain_version ON profile_matrix_runs(domain, version_id);`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile_matrix_cells (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES profile_matrix_runs(id) ON DELETE CASCADE,
        sample_url TEXT NOT NULL,
        sample_id TEXT NOT NULL,
        field TEXT NOT NULL,
        extracted TEXT,
        expected TEXT NOT NULL,
        provenance TEXT NOT NULL,
        artifact_hash TEXT NOT NULL,
        success INTEGER NOT NULL,
        failure_reason TEXT
      );
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_profile_matrix_cells_run ON profile_matrix_cells(run_id);`);
  } catch (e) {
    console.error('[Migrations] Failed to create profile_matrix tables:', e);
  }

  // Ensure onboarding_sources has metadata_json column
  try {
    const columns = db.query('PRAGMA table_info(onboarding_sources)').all() as Array<{ name: string }>;
    if (columns.length > 0 && !columns.some(col => col.name === 'metadata_json')) {
      db.exec('ALTER TABLE onboarding_sources ADD COLUMN metadata_json TEXT;');
      console.log('[Migrations] Added metadata_json column to onboarding_sources.');
    }
  } catch (e) {
    console.error('Failed to update onboarding_sources columns:', e);
  }

  // Ensure domain_status table exists
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS domain_status (
        domain TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        reason TEXT
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_domain_status_status ON domain_status(status);
    `);
  } catch (e) {
    console.error('Failed to create domain_status table:', e);
  }

  // Ensure catalog_health_proposals table exists
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS catalog_health_proposals (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id),
        field TEXT NOT NULL,
        old_value TEXT NOT NULL,
        new_value TEXT NOT NULL,
        affected_skus TEXT NOT NULL,
        reason TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        source TEXT NOT NULL DEFAULT 'deterministic',
        status TEXT NOT NULL DEFAULT 'proposed',
        change_set_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_catalog_health_proposals_ws ON catalog_health_proposals(workspace_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_catalog_health_proposals_status ON catalog_health_proposals(status);
    `);
  } catch (e) {
    console.error('Failed to create catalog_health_proposals table:', e);
  }


  // Ensure profile_generations table exists (audit trail for LLM-generated
  // selector profile proposals; one row per generation attempt).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile_generations (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        source_url TEXT NOT NULL,
        expected_name TEXT,
        brand_hint TEXT,
        selectors_json TEXT NOT NULL,
        field_samples_json TEXT,
        validation_json TEXT,
        status TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0,
        llm_provider TEXT,
        llm_model TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        promoted_at TEXT
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_generations_domain ON profile_generations(domain);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_generations_status ON profile_generations(status);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_generations_domain_status ON profile_generations(domain, status);
    `);
  } catch (e) {
    console.error('Failed to create profile_generations table:', e);
  }

  // Profile generation revisions — versioned history of selector proposals
  // tied to a parent `profile_generations` row. Each revision may carry
  // its own feedback/selectors/validation and is created either by the
  // generator (initial_generation) or by an operator-driven structured
  // revision request (manager_feedback / manual_css / system_validation).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile_generation_revisions (
        id TEXT PRIMARY KEY,
        generation_id TEXT NOT NULL REFERENCES profile_generations(id) ON DELETE CASCADE,
        revision_number INTEGER NOT NULL,
        parent_revision_id TEXT REFERENCES profile_generation_revisions(id),
        source TEXT NOT NULL,
        feedback_json TEXT,
        selectors_json TEXT NOT NULL,
        field_samples_json TEXT,
        validation_summary_json TEXT,
        status TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0,
        llm_task TEXT,
        llm_provider TEXT,
        llm_model TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_generation_revisions_generation
        ON profile_generation_revisions(generation_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_generation_revisions_parent
        ON profile_generation_revisions(parent_revision_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_generation_revisions_status
        ON profile_generation_revisions(status);
    `);
  } catch (e) {
    console.error('Failed to create profile_generation_revisions table:', e);
  }

  // Per-revision, per-field, per-sample validation evidence. Records the
  // extracted value (or image previews) plus any warnings the governance
  // service surfaced. Status values: pass | warning | fail.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile_generation_validation_results (
        id TEXT PRIMARY KEY,
        revision_id TEXT NOT NULL REFERENCES profile_generation_revisions(id) ON DELETE CASCADE,
        selector_field TEXT NOT NULL,
        sample_url TEXT NOT NULL,
        item_id TEXT,
        expected_name TEXT,
        brand_hint TEXT,
        extracted_value_json TEXT,
        image_previews_json TEXT,
        warnings_json TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_generation_validation_results_revision
        ON profile_generation_validation_results(revision_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_generation_validation_results_revision_field
        ON profile_generation_validation_results(revision_id, selector_field);
    `);
  } catch (e) {
    console.error('Failed to create profile_generation_validation_results table:', e);
  }

  // Per-field approval / rejection / rollback history. One row per operator
  // decision. Powers the governance UI's per-field approval semantics and
  // rollback surface; the `previous_selector` column is what rollback
  // restores from.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS profile_generation_field_decisions (
        id TEXT PRIMARY KEY,
        generation_id TEXT NOT NULL REFERENCES profile_generations(id) ON DELETE CASCADE,
        revision_id TEXT REFERENCES profile_generation_revisions(id),
        domain TEXT NOT NULL,
        selector_field TEXT NOT NULL,
        decision TEXT NOT NULL,
        previous_selector TEXT,
        proposed_selector TEXT,
        approved_selector TEXT,
        feedback_json TEXT,
        validation_result_ids_json TEXT,
        decided_at TEXT NOT NULL,
        decided_by TEXT,
        notes TEXT
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_generation_field_decisions_generation
        ON profile_generation_field_decisions(generation_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_generation_field_decisions_revision
        ON profile_generation_field_decisions(revision_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_generation_field_decisions_domain_field
        ON profile_generation_field_decisions(domain, selector_field);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profile_generation_field_decisions_domain_decision
        ON profile_generation_field_decisions(domain, decision);
    `);
  } catch (e) {
    console.error('Failed to create profile_generation_field_decisions table:', e);
  }

  // ── Add page_id to product_pages for stable page identity ────────────────
  try {
    const ppCols = db.query('PRAGMA table_info(product_pages)').all() as Array<{ name: string }>;
    if (ppCols.length > 0 && !ppCols.some(col => col.name === 'page_id')) {
      db.exec('ALTER TABLE product_pages ADD COLUMN page_id TEXT REFERENCES page_index(id);');
      console.log('[Migrations] Added page_id column to product_pages.');
    }
    const ppIdx = db.query("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_product_pages_page_id'").get();
    if (!ppIdx) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_product_pages_page_id ON product_pages(page_id);');
      console.log('[Migrations] Created idx_product_pages_page_id index.');
    }
  } catch (e) {
    console.error('[Migrations] Failed to add page_id to product_pages:', e);
  }

  // Task-specific LLM routing. Provider credentials (api_keys) hold the
  // secrets; this table only stores which provider/model each AI task
  // should use. Tasks include `product_name_consolidation`,
  // `discovery_candidate_selection` (product URL selection),
  // `profile_generation`, `profile_revision`, `product_curation`, and
  // `category_classification`. Profile tasks require an explicit row
  // (fail-closed) so a missing config never silently falls back to a
  // model the operator did not pick.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS llm_task_configs (
        id TEXT PRIMARY KEY,
        task TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        fallback_provider TEXT,
        fallback_model TEXT,
        base_url_override TEXT,
        temperature REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_llm_task_configs_task
        ON llm_task_configs(task);
    `);
  } catch (e) {
    console.error('Failed to create llm_task_configs table:', e);
  }

  try {
    db.exec('ALTER TABLE llm_task_configs ADD COLUMN reasoning_effort TEXT');
  } catch { /* column already exists */ }

  try {
    db.exec('ALTER TABLE llm_task_configs ADD COLUMN fallback_provider TEXT');
  } catch { /* column already exists */ }

  try {
    db.exec('ALTER TABLE llm_task_configs ADD COLUMN fallback_model TEXT');
  } catch { /* column already exists */ }

  // ── General AI Model Calls Telemetry Table (PR 3) ─────────────────────────
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_model_calls (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        task TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        locality TEXT NOT NULL CHECK (locality IN ('local', 'cloud')),
        started_at TEXT NOT NULL,
        ended_at TEXT,
        duration_ms INTEGER,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        status TEXT NOT NULL CHECK (status IN ('started', 'success', 'failed', 'cancelled', 'policy_denied', 'deadline_exceeded', 'unavailable')),
        fallback_from_call_id TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        estimated_api_cost_usd REAL,
        cost_basis TEXT NOT NULL CHECK (cost_basis IN ('local_zero', 'published_rate', 'unknown')),
        prompt_template_version TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ai_model_calls_ws_task ON ai_model_calls(workspace_id, task);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ai_model_calls_started ON ai_model_calls(started_at);
    `);
  } catch (e) {
    console.error('[Migrations] Failed to create ai_model_calls table:', e);
  }

  // Self-heal: older ai_model_calls tables lack the 'deadline_exceeded' status
  // in their CHECK constraint (epic #42, #40 whole-turn deadline). SQLite
  // cannot ALTER a CHECK, so rebuild the table when the stored DDL is stale.
  try {
    const modelCallsDdl = db
      .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ai_model_calls'")
      .get() as { sql?: string } | undefined;
    if (modelCallsDdl?.sql && !modelCallsDdl.sql.includes('deadline_exceeded')) {
      db.exec('ALTER TABLE ai_model_calls RENAME TO ai_model_calls_legacy');
      db.exec(`
        CREATE TABLE ai_model_calls (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          task TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          locality TEXT NOT NULL CHECK (locality IN ('local', 'cloud')),
          started_at TEXT NOT NULL,
          ended_at TEXT,
          duration_ms INTEGER,
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          status TEXT NOT NULL CHECK (status IN ('started', 'success', 'failed', 'cancelled', 'policy_denied', 'deadline_exceeded', 'unavailable')),
          fallback_from_call_id TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          estimated_api_cost_usd REAL,
          cost_basis TEXT NOT NULL CHECK (cost_basis IN ('local_zero', 'published_rate', 'unknown')),
          prompt_template_version TEXT,
          error_code TEXT,
          created_at TEXT NOT NULL
        );
      `);
      db.exec(
        'INSERT INTO ai_model_calls SELECT * FROM ai_model_calls_legacy',
      );
      db.exec('DROP TABLE ai_model_calls_legacy');
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_ai_model_calls_ws_task ON ai_model_calls(workspace_id, task)',
      );
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_ai_model_calls_started ON ai_model_calls(started_at)',
      );
      console.log('[Migrations] Rebuilt ai_model_calls with deadline_exceeded status.');
    }
  } catch (e) {
    console.error('[Migrations] Failed to refresh ai_model_calls status CHECK:', e);
  }

  // Self-heal: store_manager_turns created before the epic #42 deadline status
  // lacks 'deadline_exceeded' in its terminal_status CHECK. Rebuild when stale.
  try {
    const turnsDdl = db
      .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'store_manager_turns'")
      .get() as { sql?: string } | undefined;
    if (turnsDdl?.sql && !turnsDdl.sql.includes('deadline_exceeded')) {
      db.exec('ALTER TABLE store_manager_turns RENAME TO store_manager_turns_legacy');
      db.exec(`
        CREATE TABLE store_manager_turns (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          session_id TEXT NOT NULL REFERENCES store_manager_sessions(id) ON DELETE CASCADE,
          turn_id TEXT NOT NULL,
          phase TEXT NOT NULL CHECK (phase IN ('investigate', 'approve', 'verify')),
          status TEXT NOT NULL CHECK (status IN ('active', 'terminal')),
          terminal_status TEXT CHECK (terminal_status IN ('success', 'failed', 'cancelled', 'policy_denied', 'deadline_exceeded')),
          outcome_reason TEXT,
          total_tool_calls INTEGER NOT NULL DEFAULT 0,
          policy_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          ended_at TEXT
        );
      `);
      db.exec('INSERT INTO store_manager_turns SELECT * FROM store_manager_turns_legacy');
      db.exec('DROP TABLE store_manager_turns_legacy');
      console.log('[Migrations] Rebuilt store_manager_turns with deadline_exceeded status.');
    }
  } catch (e) {
    console.error('[Migrations] Failed to refresh store_manager_turns status CHECK:', e);
  }


  // SERP retirement: the serper_cache table (and all external paid-search
  // dependence) has been removed from the pipeline. Drop any legacy table.
  try {
    db.exec('DROP TABLE IF EXISTS serper_cache;');
  } catch (e) {
    console.error('Failed to drop legacy serper_cache table:', e);
  }

  // SERP retirement: sitemap_discovery_events no longer records paid-search
  // economics. Drop the retired columns when present (historical rows keep
  // their source_method strings for audit readability).
  try {
    const eventsCols = db.query("PRAGMA table_info(sitemap_discovery_events)").all() as Array<{ name: string }>;
    const colNames = new Set(eventsCols.map((c) => c.name));
    if (colNames.has('paid_search_fallback')) {
      db.exec('ALTER TABLE sitemap_discovery_events DROP COLUMN paid_search_fallback;');
    }
    if (colNames.has('serper_calls_avoided')) {
      db.exec('ALTER TABLE sitemap_discovery_events DROP COLUMN serper_calls_avoided;');
    }
  } catch (e) {
    console.error('Failed to drop retired sitemap_discovery_events columns:', e);
  }

  // Ensure sitemap_cache table exists. Caches the list of URLs discovered in
  // a domain's sitemap.xml (or equivalent) along with a TTL-derived expiry so
  // repeated discovery runs don't re-fetch the same file.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sitemap_cache (
        domain TEXT PRIMARY KEY,
        urls_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        source_url TEXT
      );
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sitemap_cache_domain ON sitemap_cache(domain);
    `);
  } catch (e) {
    console.error('Failed to create sitemap_cache table:', e);
  }

  // Run classification migration if not already applied
  const classificationVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('classification_schema_version') as
    | { value: string }
    | undefined;
  if (!classificationVersion) {
    const classificationSql = fs.readFileSync(CLASSIFICATION_MIGRATION_PATH, 'utf-8');
    db.exec(classificationSql);
    db.exec("INSERT INTO app_meta (key, value) VALUES ('classification_schema_version', '1');");
  }

  // ── Ensure classification_brands table exists (existing DB migration) ───────
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS classification_brands (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        aliases_json TEXT DEFAULT '[]',
        old_id_aliases_json TEXT DEFAULT '[]',
        config_hash TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, id)
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_classification_brands_workspace ON classification_brands(workspace_id);');
  } catch (e) {
    console.error('[Migrations] Failed to create classification_brands table:', e);
  }

  // ── Ensure curation orchestration tables exist (Phase 8A) ─────────────────
  try {
    // curation_runs
    db.exec(`
      CREATE TABLE IF NOT EXISTS curation_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspace(id),
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        total_items INTEGER NOT NULL DEFAULT 0,
        completed_items INTEGER NOT NULL DEFAULT 0,
        failed_items INTEGER NOT NULL DEFAULT 0,
        progress_json TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error_message TEXT
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_curation_runs_workspace ON curation_runs(workspace_id);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_curation_runs_status ON curation_runs(status);');

    // curation_run_items
    db.exec(`
      CREATE TABLE IF NOT EXISTS curation_run_items (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES curation_runs(id) ON DELETE CASCADE,
        onboarding_item_id TEXT NOT NULL,
        sku TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error_message TEXT
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_curation_run_items_run ON curation_run_items(run_id);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_curation_run_items_status ON curation_run_items(status);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_curation_run_items_sku ON curation_run_items(sku);');

    // curation_run_groups
    db.exec(`
      CREATE TABLE IF NOT EXISTS curation_run_groups (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES curation_runs(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL,
        group_label TEXT NOT NULL,
        skus_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_curation_run_groups_run ON curation_run_groups(run_id);');

    // curation_model_calls
    db.exec(`
      CREATE TABLE IF NOT EXISTS curation_model_calls (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES curation_runs(id) ON DELETE CASCADE,
        run_item_id TEXT REFERENCES curation_run_items(id) ON DELETE SET NULL,
        task TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        duration_ms INTEGER,
        status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
        error_message TEXT,
        created_at TEXT NOT NULL
      );
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_curation_model_calls_run ON curation_model_calls(run_id);');
  } catch (e) {
    console.error('[Migrations] Failed to create curation orchestration tables:', e);
  }

  // ── Migration to expand classification_stage_results CHECK constraint ──────
  //
  // The original CHECK constraint included 6 stage names. After adding
  // name_consolidation, existing databases need the table rebuilt with
  // the expanded constraint. This runs only when needed.
  try {
    const tableInfo = db.query('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'classification_stage_results') as { sql: string } | undefined;
    if (tableInfo && tableInfo.sql && !tableInfo.sql.includes('name_consolidation')) {
      console.log('[Migrations] Expanding classification_stage_results CHECK constraint for name_consolidation...');
      db.exec(`
        CREATE TABLE IF NOT EXISTS classification_stage_results_new (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES classification_runs(id) ON DELETE CASCADE,
          stage_name TEXT NOT NULL CHECK (stage_name IN ('evidence_extraction', 'name_consolidation', 'primary_product_type_proposal', 'attribute_applicability', 'product_attribute_proposals', 'category_page_proposals', 'product_draft_projection')),
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'abstained')),
          output_json TEXT,
          error_message TEXT,
          started_at TEXT NOT NULL,
          completed_at TEXT
        );
      `);
      db.exec('INSERT INTO classification_stage_results_new SELECT * FROM classification_stage_results;');
      db.exec('DROP TABLE classification_stage_results;');
      db.exec('ALTER TABLE classification_stage_results_new RENAME TO classification_stage_results;');
      db.exec('CREATE INDEX IF NOT EXISTS idx_classification_stage_results_run ON classification_stage_results(run_id);');
      console.log('[Migrations] classification_stage_results CHECK constraint expanded successfully.');
    }
  } catch (e) {
    console.error('[Migrations] Failed to expand classification_stage_results CHECK constraint:', e);
  }

  // ── Migration to expand classification_stage_results CHECK for packaging_ocr ──
  //
  // Packaging-OCR overhaul plan P2-T6: the flag-gated `packaging_ocr`
  // classification stage persists its (succeeded/abstained/failed) result
  // through the same `classification_stage_results` table as every other
  // pipeline stage. Existing databases carry a CHECK constraint frozen to the
  // legacy seven stage names; rebuild the table with `packaging_ocr` added.
  // Purely additive (constraint widening only) and idempotent — flag-OFF
  // behavior is unchanged because nothing writes the new value until the
  // master flag is enabled.
  //
  // Hardening (post-review fixup): mirrors the catalog-classification rebuild
  // precedent above — orphaned rows (run_id not in classification_runs, left
  // by prior operations that ran with foreign_keys=OFF) are deleted BEFORE
  // the copy so the FK-enforcing rebuild can never fail mid-swap and leave a
  // `classification_stage_results_new` remnant blocking retry; the whole
  // rebuild is transactional; foreign_keys is disabled around it and always
  // restored in `finally`. A partial failure therefore rolls back cleanly and
  // the migration re-runs on the next start.
  try {
    const tableInfoOcr = db.query('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'classification_stage_results') as { sql: string } | undefined;
    if (tableInfoOcr && tableInfoOcr.sql && !tableInfoOcr.sql.includes("'packaging_ocr'")) {
      console.log('[Migrations] Expanding classification_stage_results CHECK constraint for packaging_ocr...');
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.transaction(() => {
          // Retry safety: drop any _new remnant from an earlier failed swap.
          db.exec('DROP TABLE IF EXISTS classification_stage_results_new');
          // Orphaned rows first (dead data from prior foreign_keys=OFF ops):
          // copying them into the rebuilt table would violate its restored FK.
          const orphanedStageResults = db.query(
            'SELECT COUNT(*) as cnt FROM classification_stage_results WHERE run_id NOT IN (SELECT id FROM classification_runs)'
          ).get() as { cnt: number };
          if (orphanedStageResults.cnt > 0) {
            db.run('DELETE FROM classification_stage_results WHERE run_id NOT IN (SELECT id FROM classification_runs)');
            console.log(`[Migrations] Cleaned up ${orphanedStageResults.cnt} orphaned classification_stage_results row(s).`);
          }
          db.exec(`
            CREATE TABLE classification_stage_results_new (
              id TEXT PRIMARY KEY,
              run_id TEXT NOT NULL REFERENCES classification_runs(id) ON DELETE CASCADE,
              stage_name TEXT NOT NULL CHECK (stage_name IN ('packaging_ocr', 'evidence_extraction', 'name_consolidation', 'primary_product_type_proposal', 'attribute_applicability', 'product_attribute_proposals', 'category_page_proposals', 'product_draft_projection')),
              status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'abstained')),
              output_json TEXT,
              error_message TEXT,
              started_at TEXT NOT NULL,
              completed_at TEXT
            );
          `);
          db.exec('INSERT INTO classification_stage_results_new SELECT * FROM classification_stage_results;');
          db.exec('DROP TABLE classification_stage_results;');
          db.exec('ALTER TABLE classification_stage_results_new RENAME TO classification_stage_results;');
          db.exec('CREATE INDEX IF NOT EXISTS idx_classification_stage_results_run ON classification_stage_results(run_id);');
        })();
      } finally {
        // Always restore foreign key enforcement, even if the rebuild fails.
        db.exec('PRAGMA foreign_keys = ON');
      }
      console.log('[Migrations] classification_stage_results CHECK constraint expanded for packaging_ocr successfully.');
    }
  } catch (e) {
    console.error('[Migrations] Failed to expand classification_stage_results CHECK constraint for packaging_ocr:', e);
  }

  // ── Migration to expand classification_stage_results CHECK for value_gap_abstain ──
  //
  // P3 value-production ladder (plan B.P3.3): the flag-gated
  // `value_gap_abstain` stage persists its result through the same
  // `classification_stage_results` table. Existing databases carry a CHECK
  // constraint without the name; rebuild the table with `value_gap_abstain`
  // added. Purely additive (constraint widening only) and idempotent —
  // flag-OFF behavior is unchanged because nothing writes the new value until
  // BAYSTATE_CMS_VALUE_GAP_LLM is enabled. Mirrors the packaging_ocr rebuild
  // precedent exactly (orphan cleanup, transactional swap, FK restore).
  try {
    const tableInfoGap = db.query('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'classification_stage_results') as { sql: string } | undefined;
    if (tableInfoGap && tableInfoGap.sql && !tableInfoGap.sql.includes("'value_gap_abstain'")) {
      console.log('[Migrations] Expanding classification_stage_results CHECK constraint for value_gap_abstain...');
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.transaction(() => {
          // Retry safety: drop any _new remnant from an earlier failed swap.
          db.exec('DROP TABLE IF EXISTS classification_stage_results_new');
          const orphanedStageResults = db.query(
            'SELECT COUNT(*) as cnt FROM classification_stage_results WHERE run_id NOT IN (SELECT id FROM classification_runs)'
          ).get() as { cnt: number };
          if (orphanedStageResults.cnt > 0) {
            db.run('DELETE FROM classification_stage_results WHERE run_id NOT IN (SELECT id FROM classification_runs)');
            console.log(`[Migrations] Cleaned up ${orphanedStageResults.cnt} orphaned classification_stage_results row(s).`);
          }
          db.exec(`
            CREATE TABLE classification_stage_results_new (
              id TEXT PRIMARY KEY,
              run_id TEXT NOT NULL REFERENCES classification_runs(id) ON DELETE CASCADE,
              stage_name TEXT NOT NULL CHECK (stage_name IN ('packaging_ocr', 'evidence_extraction', 'name_consolidation', 'primary_product_type_proposal', 'attribute_applicability', 'product_attribute_proposals', 'value_gap_abstain', 'category_page_proposals', 'product_draft_projection')),
              status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'abstained')),
              output_json TEXT,
              error_message TEXT,
              started_at TEXT NOT NULL,
              completed_at TEXT
            );
          `);
          db.exec('INSERT INTO classification_stage_results_new SELECT * FROM classification_stage_results;');
          db.exec('DROP TABLE classification_stage_results;');
          db.exec('ALTER TABLE classification_stage_results_new RENAME TO classification_stage_results;');
          db.exec('CREATE INDEX IF NOT EXISTS idx_classification_stage_results_run ON classification_stage_results(run_id);');
        })();
      } finally {
        // Always restore foreign key enforcement, even if the rebuild fails.
        db.exec('PRAGMA foreign_keys = ON');
      }
      console.log('[Migrations] classification_stage_results CHECK constraint expanded for value_gap_abstain successfully.');
    }
  } catch (e) {
    console.error('[Migrations] Failed to expand classification_stage_results CHECK constraint for value_gap_abstain:', e);
  }

  // Run stage pipeline migration if not already applied
  const stagePipelineVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('stage_pipeline_schema_version') as
    | { value: string }
    | undefined;
  if (!stagePipelineVersion) {
    const stagePipelineSql = fs.readFileSync(STAGE_PIPELINE_MIGRATION_PATH, 'utf-8');
    db.exec(stagePipelineSql);
    db.exec("INSERT INTO app_meta (key, value) VALUES ('stage_pipeline_schema_version', '1');");
  }

  // Run cohort migration if not already applied (issue #30 PR1; candidate
  // schema v4 = FINAL from issue #31 cleanup F3, plus PR3 M1 v5 run table and
  // PR4 C1 v6 outcome/dependency columns). One-shot SQL file gated by an
  // app_meta marker. cohort-migration.sql now carries the FINAL v7 shape (v4
  // candidate tables + the v5 `classification_cohort_runs` parent run table
  // with the PR4 C1 `product_type_outcome` column + the v6
  // `classification_proposal_dependencies` table + the PR6 C1 v7
  // `classification_cohort_outputs` table), so a FRESH install
  // executes the SQL and writes marker '7' directly. Existing databases
  // advance through the hops below: marker '1' runs the v1→v2 rebuild (CASCADE
  // FK, v2-era wide CHECK) → writes '2', then the v2→v3 rebuild narrows the
  // CHECK → writes '3', then the v3→v4 rebuild drops the execution-metadata
  // columns → writes '4', then the v4→v5 hop execs the idempotent cohort SQL
  // (creating classification_cohort_runs + indexes) → writes '5', then the
  // v5→v6 hop execs the idempotent cohort SQL (creating
  // classification_proposal_dependencies + indexes; the run table already
  // exists so its CREATE TABLE is a no-op) → writes '6', then the v6→v7 hop
  // execs the idempotent cohort SQL (creating classification_cohort_outputs +
  // its index) → writes '7'; marker '2' runs the v2→v3, v3→v4, v4→v5, v5→v6
  // and v6→v7 hops; marker '3' runs the v3→v4, v4→v5, v5→v6 and v6→v7 hops;
  // marker '4' runs the v4→v5, v5→v6 and v6→v7 hops; marker '5' runs the
  // v5→v6 and v6→v7 hops; marker '6' runs the v6→v7 hop; marker '7' skips
  // everything. The PRAGMA-guarded
  // `product_type_outcome` ALTER (pre-C1 '5' databases) lives OUTSIDE the
  // gate below.
  const cohortVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('curation_cohort_schema_version') as
    | { value: string }
    | undefined;
  if (!cohortVersion) {
    const cohortSql = fs.readFileSync(COHORT_MIGRATION_PATH, 'utf-8');
    db.exec(cohortSql);
    db.exec("INSERT INTO app_meta (key, value) VALUES ('curation_cohort_schema_version', '7');");
  }

  // ── Curation cohorts v1 → v2: batch deletion must cascade ────────────────
  //
  // v1 created `curation_cohorts.batch_id` with a plain REFERENCES clause, so
  // deleting an onboarding batch would leave orphaned cohort rows. SQLite
  // cannot alter a foreign key in place, so existing v1 databases are rebuilt
  // with the ON DELETE CASCADE FK — the same table-rebuild precedent as the
  // classification_evidence CHECK expansion: PRAGMA foreign_keys OFF around
  // the swap, create `_new`, copy, drop, rename, recreate indexes, then a
  // `PRAGMA foreign_key_check` and restoring FK enforcement in `finally`.
  // This block runs ONLY for a marker-'1' database and writes marker '2',
  // which the v2→v3 hop below then consumes; fresh installs already carry
  // marker '5'.
  const cohortV1 = db.query('SELECT value FROM app_meta WHERE key = ?').get('curation_cohort_schema_version') as
    | { value: string }
    | undefined;
  if (cohortV1 && cohortV1.value === '1') {
    console.log('[Migrations] Rebuilding curation_cohorts with ON DELETE CASCADE on batch_id (v1 → v2)...');
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE curation_cohorts_new (
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
        db.exec('INSERT INTO curation_cohorts_new SELECT * FROM curation_cohorts');
        db.exec('DROP TABLE curation_cohorts');
        db.exec('ALTER TABLE curation_cohorts_new RENAME TO curation_cohorts');
        db.exec('CREATE INDEX IF NOT EXISTS idx_curation_cohorts_batch ON curation_cohorts(batch_id, status)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_curation_cohort_members_item ON curation_cohort_members(onboarding_item_id)');
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_curation_cohorts_active_group
          ON curation_cohorts(batch_id, group_key, grouping_version) WHERE status != 'superseded'`);
      })();
    } finally {
      // Always restore foreign key enforcement, even if the rebuild fails.
      db.exec('PRAGMA foreign_keys = ON');
    }
    const cohortFkViolations = db.query("PRAGMA foreign_key_check('curation_cohorts')").all();
    if (cohortFkViolations.length > 0) {
      console.warn(`[Migrations] ${cohortFkViolations.length} FK violations in curation_cohorts after v2 rebuild (pre-existing):`, cohortFkViolations.slice(0, 5));
    }
    db.exec("INSERT INTO app_meta (key, value) VALUES ('curation_cohort_schema_version', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value;");
    console.log('[Migrations] curation_cohort_schema_version bumped to 2.');
  }

  // ── Curation cohorts v2 → v3: narrow the status CHECK (D7) ──────────────
  //
  // The cohort row is a candidate-family record only; execution/lifecycle
  // states (`running`/`completed`/`failed`/`conflicted`) never belong on it
  // (cohort RUN state is owned by the cohort run, PR3+). SQLite cannot alter a
  // CHECK in place, so the table is rebuilt — same swap precedent as v1→v2:
  // PRAGMA foreign_keys OFF around the swap, create `_new` with the narrowed
  // CHECK, copy, drop, rename, recreate the 3 indexes, then `PRAGMA
  // foreign_key_check` and restoring FK enforcement in `finally`. Legacy
  // execution statuses found in existing data are deterministically mapped to
  // `ready` (dropping the never-durable run state leaves the candidate family
  // a stable candidate); the four candidate/superseded statuses are preserved
  // verbatim. The v3 shape still carries `started_at`/`completed_at` (the
  // v3→v4 hop drops them). Runs for marker-'2' databases (and marker-'1'
  // databases that the hop above just advanced to '2'); marker '4' skips.
  const cohortV2 = db.query('SELECT value FROM app_meta WHERE key = ?').get('curation_cohort_schema_version') as
    | { value: string }
    | undefined;
  if (cohortV2 && cohortV2.value === '2') {
    console.log('[Migrations] Rebuilding curation_cohorts with the narrowed v3 status CHECK (v2 → v3)...');
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE curation_cohorts_new (
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
          INSERT INTO curation_cohorts_new
            (id, workspace_id, batch_id, group_key, group_label, grouping_version,
             membership_hash, status, blocked_reason, created_at, updated_at,
             started_at, completed_at, superseded_at)
          SELECT
            id, workspace_id, batch_id, group_key, group_label, grouping_version,
            membership_hash,
            CASE WHEN status IN ('running','completed','failed','conflicted') THEN 'ready' ELSE status END,
            blocked_reason, created_at, updated_at, started_at, completed_at, superseded_at
          FROM curation_cohorts
        `);
        db.exec('DROP TABLE curation_cohorts');
        db.exec('ALTER TABLE curation_cohorts_new RENAME TO curation_cohorts');
        db.exec('CREATE INDEX IF NOT EXISTS idx_curation_cohorts_batch ON curation_cohorts(batch_id, status)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_curation_cohort_members_item ON curation_cohort_members(onboarding_item_id)');
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_curation_cohorts_active_group
          ON curation_cohorts(batch_id, group_key, grouping_version) WHERE status != 'superseded'`);
      })();
    } finally {
      // Always restore foreign key enforcement, even if the rebuild fails.
      db.exec('PRAGMA foreign_keys = ON');
    }
    const cohortFkViolations = db.query("PRAGMA foreign_key_check('curation_cohorts')").all();
    if (cohortFkViolations.length > 0) {
      console.warn(`[Migrations] ${cohortFkViolations.length} FK violations in curation_cohorts after v3 rebuild (pre-existing):`, cohortFkViolations.slice(0, 5));
    }
    db.exec("INSERT INTO app_meta (key, value) VALUES ('curation_cohort_schema_version', '3') ON CONFLICT(key) DO UPDATE SET value = excluded.value;");
    console.log('[Migrations] curation_cohort_schema_version bumped to 3.');
  }

  // ── Curation cohorts v3 → v4: drop execution metadata (issue #31 F3) ───
  //
  // v3 still carries `started_at`/`completed_at`; once `classification_cohort_runs`
  // owns execution state, candidate cohorts must not hold a second authority
  // for execution timestamps. SQLite cannot drop columns in place, so the
  // table is rebuilt — same swap precedent as v1→v2/v2→v3: PRAGMA foreign_keys
  // OFF around the swap, create `_new` WITHOUT the two columns, copy, drop,
  // rename, recreate the 3 indexes, then `PRAGMA foreign_key_check` and
  // restoring FK enforcement in `finally`. Existing values are simply dropped
  // (they were never consumed as authority). Runs for marker-'3' databases
  // (and marker-'1'/'2' databases advanced by the hops above); marker '4'
  // skips.
  const cohortV3 = db.query('SELECT value FROM app_meta WHERE key = ?').get('curation_cohort_schema_version') as
    | { value: string }
    | undefined;
  if (cohortV3 && cohortV3.value === '3') {
    console.log('[Migrations] Rebuilding curation_cohorts without execution metadata columns (v3 → v4)...');
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE curation_cohorts_new (
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
            superseded_at TEXT
          )
        `);
        db.exec(`
          INSERT INTO curation_cohorts_new
            (id, workspace_id, batch_id, group_key, group_label, grouping_version,
             membership_hash, status, blocked_reason, created_at, updated_at, superseded_at)
          SELECT
            id, workspace_id, batch_id, group_key, group_label, grouping_version,
            membership_hash, status, blocked_reason, created_at, updated_at, superseded_at
          FROM curation_cohorts
        `);
        db.exec('DROP TABLE curation_cohorts');
        db.exec('ALTER TABLE curation_cohorts_new RENAME TO curation_cohorts');
        db.exec('CREATE INDEX IF NOT EXISTS idx_curation_cohorts_batch ON curation_cohorts(batch_id, status)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_curation_cohort_members_item ON curation_cohort_members(onboarding_item_id)');
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_curation_cohorts_active_group
          ON curation_cohorts(batch_id, group_key, grouping_version) WHERE status != 'superseded'`);
      })();
    } finally {
      // Always restore foreign key enforcement, even if the rebuild fails.
      db.exec('PRAGMA foreign_keys = ON');
    }
    const cohortFkViolations = db.query("PRAGMA foreign_key_check('curation_cohorts')").all();
    if (cohortFkViolations.length > 0) {
      console.warn(`[Migrations] ${cohortFkViolations.length} FK violations in curation_cohorts after v4 rebuild (pre-existing):`, cohortFkViolations.slice(0, 5));
    }
    db.exec("INSERT INTO app_meta (key, value) VALUES ('curation_cohort_schema_version', '4') ON CONFLICT(key) DO UPDATE SET value = excluded.value;");
    console.log('[Migrations] curation_cohort_schema_version bumped to 4.');
  }

  // ── Curation cohorts v4 → v5: classification_cohort_runs (issue #30 PR3 M1) ─
  //
  // v5 adds the parent cohort-run table `classification_cohort_runs` (execution
  // lifecycle + claim lease) and its indexes to cohort-migration.sql. Purely
  // additive — the file is the FINAL v5 shape, so the hop is `db.exec(cohortSql)`
  // (idempotent via CREATE TABLE/INDEX IF NOT EXISTS) plus the marker bump,
  // mirroring the fresh-install path. Runs for marker-'4' databases (and
  // marker-'1'/'2'/'3' databases advanced by the hops above); marker '5' skips.
  const cohortV4 = db.query('SELECT value FROM app_meta WHERE key = ?').get('curation_cohort_schema_version') as
    | { value: string }
    | undefined;
  if (cohortV4 && cohortV4.value === '4') {
    console.log('[Migrations] Adding classification_cohort_runs (cohort schema v4 → v5)...');
    const cohortSql = fs.readFileSync(COHORT_MIGRATION_PATH, 'utf-8');
    db.exec(cohortSql);
    db.exec("INSERT INTO app_meta (key, value) VALUES ('curation_cohort_schema_version', '5') ON CONFLICT(key) DO UPDATE SET value = excluded.value;");
    console.log('[Migrations] curation_cohort_schema_version bumped to 5.');
  }

  // ── Curation cohorts v5 → v6: PR4 C1 outcome column + dependencies ──
  //
  // v6 is additive: `classification_proposal_dependencies` (+ 2 indexes) and
  // the nullable `product_type_outcome` CHECK column on
  // `classification_cohort_runs`. The cohort SQL file is the FINAL v6 shape,
  // so the hop is `db.exec(cohortSql)` (idempotent — creates the dependency
  // table and its indexes; the run-table CREATE is a no-op because the table
  // already exists) plus the marker bump, mirroring the fresh-install path.
  // The `product_type_outcome` COLUMN for a pre-C1 '5' database is added by
  // the PRAGMA-guarded ALTER block OUTSIDE the gate below (SQLite cannot add
  // the column via the idempotent CREATE TABLE IF NOT EXISTS). Runs for
  // marker-'5' databases (and marker-'1'/'2'/'3'/'4' databases advanced by
  // the hops above); marker '6' skips.
  const cohortV5 = db.query('SELECT value FROM app_meta WHERE key = ?').get('curation_cohort_schema_version') as
    | { value: string }
    | undefined;
  if (cohortV5 && cohortV5.value === '5') {
    console.log('[Migrations] Adding classification_proposal_dependencies + product_type_outcome (cohort schema v5 → v6)...');
    const cohortSql = fs.readFileSync(COHORT_MIGRATION_PATH, 'utf-8');
    db.exec(cohortSql);
    db.exec("INSERT INTO app_meta (key, value) VALUES ('curation_cohort_schema_version', '6') ON CONFLICT(key) DO UPDATE SET value = excluded.value;");
    console.log('[Migrations] curation_cohort_schema_version bumped to 6.');
  }

  // ── Curation cohorts v6 → v7: classification_cohort_outputs (issue #30 PR6 C1) ─
  //
  // v7 adds the durable cohort-output table `classification_cohort_outputs`
  // (+ supporting index) to cohort-migration.sql. Purely additive — the file
  // is the FINAL v7 shape, so the hop is `db.exec(cohortSql)` (idempotent via
  // CREATE TABLE/INDEX IF NOT EXISTS) plus the marker bump, mirroring the
  // fresh-install path. Runs for marker-'6' databases (and marker-'1'/'2'/
  // '3'/'4'/'5' databases advanced by the hops above); marker '7' skips.
  const cohortV6 = db.query('SELECT value FROM app_meta WHERE key = ?').get('curation_cohort_schema_version') as
    | { value: string }
    | undefined;
  if (cohortV6 && cohortV6.value === '6') {
    console.log('[Migrations] Adding classification_cohort_outputs (cohort schema v6 → v7)...');
    const cohortSql = fs.readFileSync(COHORT_MIGRATION_PATH, 'utf-8');
    db.exec(cohortSql);
    db.exec("INSERT INTO app_meta (key, value) VALUES ('curation_cohort_schema_version', '7') ON CONFLICT(key) DO UPDATE SET value = excluded.value;");
    console.log('[Migrations] curation_cohort_schema_version bumped to 7.');
  }

  // classification_runs.cohort_run_id (issue #30, PR3 M1) — child per-SKU runs
  // link to their parent cohort run. ON DELETE SET NULL per the epic; plain FK
  // (mirrors classification_runs.onboarding_item_id). PRAGMA-guarded and
  // OUTSIDE the version gate so databases already at marker '5' still receive
  // the column; placed after the cohort block so the FK target table
  // (classification_cohort_runs) always exists first. Legacy rows keep NULL.
  try {
    const runCols = db.query('PRAGMA table_info(classification_runs)').all() as Array<{ name: string }>;
    if (runCols.length > 0 && !runCols.some(col => col.name === 'cohort_run_id')) {
      db.exec('ALTER TABLE classification_runs ADD COLUMN cohort_run_id TEXT REFERENCES classification_cohort_runs(id) ON DELETE SET NULL;');
      console.log('[Migrations] Added classification_runs.cohort_run_id.');
    }
  } catch (e) {
    console.error('[Migrations] Failed to add cohort_run_id to classification_runs:', e);
  }
  // Supporting FK lookup index, outside the version gate (precedent
  // idx_classification_runs_one_running_item, migrations.ts:1049-1056).
  db.exec('CREATE INDEX IF NOT EXISTS idx_classification_runs_cohort_run_id ON classification_runs(cohort_run_id);');

  // ── classification_cohort_snapshots + evidence_snapshot_id (issue #30 PR3 M2) ─
  //
  // M2 adds the content-addressed execution-evidence snapshot table and links
  // each cohort run row to its persisted snapshot. Both are additive and run
  // OUTSIDE the version gate: a marker-'5' database created before M2 (which
  // already has classification_cohort_runs from the M1 file) still needs the
  // snapshots table, and the fresh-install/version-gated path (cohort SQL
  // file) already creates both — so this block is a no-op there. The table
  // creation is idempotent (the cohort SQL file uses CREATE TABLE IF NOT
  // EXISTS); the ALTER is PRAGMA-guarded. The run row must reference the
  // persisted snapshot, so the snapshots table is guaranteed to exist first.
  try {
    const hasSnapshotsTable = db.query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'classification_cohort_snapshots'",
    ).get();
    if (!hasSnapshotsTable) {
      const cohortSql = fs.readFileSync(COHORT_MIGRATION_PATH, 'utf-8');
      db.exec(cohortSql);
      console.log('[Migrations] Added classification_cohort_snapshots (PR3 M2).');
    }
    const cohortRunCols = db.query('PRAGMA table_info(classification_cohort_runs)').all() as Array<{ name: string }>;
    if (cohortRunCols.length > 0 && !cohortRunCols.some(col => col.name === 'evidence_snapshot_id')) {
      db.exec('ALTER TABLE classification_cohort_runs ADD COLUMN evidence_snapshot_id TEXT REFERENCES classification_cohort_snapshots(id);');
      console.log('[Migrations] Added classification_cohort_runs.evidence_snapshot_id.');
    }
  } catch (e) {
    console.error('[Migrations] Failed to add classification_cohort_snapshots / evidence_snapshot_id:', e);
  }

  // ── classification_proposal_dependencies + product_type_outcome (issue #30 PR4 C1) ─
  //
  // PR4 C1 adds the v6 dependency table and the nullable `product_type_outcome`
  // CHECK column on classification_cohort_runs. Both are additive and run
  // OUTSIDE the version gate: a pre-C1 marker-'5' database (created from the
  // PR3 file before C1) still needs the column — the idempotent cohort SQL
  // exec in the v5→v6 hop creates the dependency table + indexes but CANNOT
  // add the column (CREATE TABLE IF NOT EXISTS is a no-op for the existing
  // run table) — and the fresh-install/version-gated path (cohort SQL file)
  // already creates both, so this block is a no-op there. Table creation is
  // idempotent (cohort SQL file uses CREATE TABLE/INDEX IF NOT EXISTS); the
  // column ALTER is PRAGMA-guarded (precedent: evidence_snapshot_id above).
  // Existing rows keep NULL outcome — no backfill (historical runs predate
  // execution types).
  try {
    const hasDependencyTable = db.query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'classification_proposal_dependencies'",
    ).get();
    if (!hasDependencyTable) {
      const cohortSql = fs.readFileSync(COHORT_MIGRATION_PATH, 'utf-8');
      db.exec(cohortSql);
      console.log('[Migrations] Added classification_proposal_dependencies (PR4 C1).');
    }
    const cohortRunColsV6 = db.query('PRAGMA table_info(classification_cohort_runs)').all() as Array<{ name: string }>;
    if (cohortRunColsV6.length > 0 && !cohortRunColsV6.some(col => col.name === 'product_type_outcome')) {
      db.exec("ALTER TABLE classification_cohort_runs ADD COLUMN product_type_outcome TEXT CHECK (product_type_outcome IS NULL OR product_type_outcome IN ('coherent','coherent_with_abstentions','conflicted','abstained'));");
      console.log('[Migrations] Added classification_cohort_runs.product_type_outcome.');
    }
  } catch (e) {
    console.error('[Migrations] Failed to add classification_proposal_dependencies / product_type_outcome:', e);
  }
  // ── Clean up product_draft_projection noise proposals ───────────────────
  //
  // The product_draft_projection stage previously emitted a fake
  // field_assignment proposal with targetId='product_draft_projection'.
  // These proposals are noise — they are never consumed by promotion or
  // review, but they pollute the classification_proposals table and
  // confuse downstream queries. Remove them in a one-time cleanup.
  try {
    const draftProjCleanup = db.query('SELECT value FROM app_meta WHERE key = ?').get('product_draft_projection_cleanup') as
      | { value: string }
      | undefined;
    if (!draftProjCleanup) {
      const deleted = db.query("DELETE FROM classification_proposals WHERE target_id = 'product_draft_projection'").run();
      console.log(`[Migrations] Cleaned up ${deleted.changes} product_draft_projection proposals.`);
      db.exec("INSERT INTO app_meta (key, value) VALUES ('product_draft_projection_cleanup', '1');");
    }
  } catch (e) {
    console.error('[Migrations] product_draft_projection cleanup failed:', e);
  }

  // ── Seed category_page_assignment LLM task config ───────────────────────
  //
  // The category_page_assignment task is used by the LLM-first page assignment
  // pipeline (page-assignment-llm.ts). It routes to deepseek-v4-pro, matching
  // the existing category_classification config.
  try {
    const catPageSeeded = db.query('SELECT value FROM app_meta WHERE key = ?').get('category_page_assignment_task_seeded') as
      | { value: string }
      | undefined;
    if (!catPageSeeded) {
      const existing = db.query('SELECT id FROM llm_task_configs WHERE task = ?').get('category_page_assignment') as
        | { id: string }
        | undefined;
      if (!existing) {
        const now = new Date().toISOString();
        const id = randomUUID();
        db.exec(`INSERT INTO llm_task_configs (id, task, provider, model, created_at, updated_at) VALUES ('${id}', 'category_page_assignment', 'deepseek', 'deepseek-v4-pro', '${now}', '${now}')`);
        console.log('[Migrations] Seeded category_page_assignment task config (deepseek-v4-pro).');
      }
      db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('category_page_assignment_task_seeded', '1');");
    }
  } catch (e) {
    console.error('[Migrations] Failed to seed category_page_assignment task config:', e);
  }

  // Ensure store_manager_chat_history table exists
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS store_manager_chat_history (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        role TEXT NOT NULL,
        message_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    
    // Add columns if they do not exist
    try {
      db.exec("ALTER TABLE store_manager_chat_history ADD COLUMN thread_id TEXT;");
    } catch { /* already exists */ }
    try {
      db.exec("ALTER TABLE store_manager_chat_history ADD COLUMN thread_title TEXT;");
    } catch { /* already exists */ }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_store_manager_chat_history_ws 
        ON store_manager_chat_history(workspace_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_store_manager_chat_history_thread 
        ON store_manager_chat_history(thread_id);
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_store_manager_chat_history_created 
        ON store_manager_chat_history(created_at);
    `);
  } catch (e) {
    console.error('[Migrations] Failed to create store_manager_chat_history table:', e);
  }

  // ── Run curation V2 migration if not already applied ──────────────────────
  //
  // Adds columns for atomic item claims, run-scoped proposal tracking,
  // cohort snapshots, evidence denormalization, and refresh-staleness columns.
  // Each ALTER TABLE ADD COLUMN is wrapped in a PRAGMA column-existence guard
  // so the migration is idempotent in all scenarios.
  try {
    const curationV2Version = db.query('SELECT value FROM app_meta WHERE key = ?').get('curation_v2_schema_version') as
      | { value: string }
      | undefined;
    if (!curationV2Version) {
      console.log('[Migrations] Running curation V2 migration...');

      // Helper: add a column only if it does not already exist
      const cols = (tbl: string) => db.query('PRAGMA table_info(' + tbl + ')').all() as Array<{ name: string }>;
      const addCol = (tbl: string, col: string, def: string) => {
        if (!cols(tbl).some((c: { name: string }) => c.name === col)) {
          db.exec('ALTER TABLE ' + tbl + ' ADD COLUMN ' + col + ' ' + def);
          console.log('[Migrations] Added ' + tbl + '.' + col);
        }
      };

      // 1. onboarding_items — worker claim & sourcing decision columns
      addCol('onboarding_items', 'claimed_by', 'TEXT');
      addCol('onboarding_items', 'claimed_at', 'TEXT');
      addCol('onboarding_items', 'sourcing_decision_json', 'TEXT');

      // 2. classification_proposals — evidence denormalization, staleness, metadata
      addCol('classification_proposals', 'evidence_ids_json', "TEXT DEFAULT '[]'");
      addCol('classification_proposals', 'stale_at', 'TEXT');
      addCol('classification_proposals', 'superseded_by_run_id', 'TEXT REFERENCES classification_runs(id)');
      addCol('classification_proposals', 'metadata_json', "TEXT DEFAULT '{}'");

      // 3. curation_run_items — link to per-SKU ClassificationRun
      addCol('curation_run_items', 'classification_run_id', 'TEXT REFERENCES classification_runs(id) ON DELETE SET NULL');

      // 4. curation_runs — batch link, curation mode, config snapshot, snapshots
      addCol('curation_runs', 'batch_id', 'TEXT REFERENCES onboarding_batches(id)');
      addCol('curation_runs', 'curation_mode', "TEXT NOT NULL DEFAULT 'modular' CHECK (curation_mode IN ('modular', 'legacy'))");
      addCol('curation_runs', 'config_snapshot_id_v2', 'TEXT REFERENCES classification_config_snapshots(id)');
      addCol('curation_runs', 'input_snapshot_json', 'TEXT');
      addCol('curation_runs', 'cohort_snapshot_json', 'TEXT');

      // 5. curation_model_calls — cost observability
      addCol('curation_model_calls', 'estimated_cost_usd', 'REAL');

      // 6. New indexes (CREATE INDEX IF NOT EXISTS is inherently idempotent)
      db.exec('CREATE INDEX IF NOT EXISTS idx_classification_proposals_run_sku_status ON classification_proposals(run_id, product_sku, status)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_onboarding_items_stage_status_claimed ON onboarding_items(stage, stage_status, claimed_by)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_curation_runs_batch ON curation_runs(batch_id)');

      db.exec("INSERT INTO app_meta (key, value) VALUES ('curation_v2_schema_version', '1');");
      console.log('[Migrations] Curation V2 migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Curation V2 migration failed:', e);
  }

  // Classification is item-centric: at most one live run may own an item.
  // Keep this outside the version guard so databases that already recorded
  // curation_v2_schema_version still receive the concurrency constraint.
  // If historical duplicate running rows exist, index creation fails closed
  // instead of silently choosing a winner.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_classification_runs_one_running_item
    ON classification_runs(onboarding_item_id)
    WHERE onboarding_item_id IS NOT NULL AND status = 'running'
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_remote_drift_ws_sku_status
    ON remote_drift(workspace_id, sku, status)
  `);

  // ── Catalog Classification Migration ──────────────────────────────────────
  //
  // Adds source_kind and source_product_hash columns to classification_runs,
  // expands the classification_evidence CHECK constraint to include 'catalog_product',
  // and creates new indexes for catalog-run concurrency and lookup.
  try {
    const catalogClassVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('catalog_classification_schema_version') as
      | { value: string }
      | undefined;
    if (!catalogClassVersion) {
      console.log('[Migrations] Running catalog classification migration...');

      // Add columns to classification_runs
      const runCols = db.query('PRAGMA table_info(classification_runs)').all() as Array<{ name: string }>;
      if (!runCols.some(c => c.name === 'source_kind')) {
        db.exec("ALTER TABLE classification_runs ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'onboarding' CHECK (source_kind IN ('onboarding', 'catalog_product'))");
      }
      if (!runCols.some(c => c.name === 'source_product_hash')) {
        db.exec('ALTER TABLE classification_runs ADD COLUMN source_product_hash TEXT');
      }

      // Rebuild classification_evidence to update CHECK constraint for source.
      // Foreign keys are temporarily disabled so classification_proposal_evidence
      // (which references classification_evidence) survives the table swap.
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        // ── Clean up orphaned rows first ───────────────────────────────
        // Rows whose run_id doesn't exist in classification_runs are dead
        // data from prior operations that ran with foreign_keys=OFF.
        const orphanedEvidence = db.query(
          "SELECT COUNT(*) as cnt FROM classification_evidence WHERE run_id NOT IN (SELECT id FROM classification_runs)"
        ).get() as { cnt: number };
        const orphanedStageResults = db.query(
          "SELECT COUNT(*) as cnt FROM classification_stage_results WHERE run_id NOT IN (SELECT id FROM classification_runs)"
        ).get() as { cnt: number };
        const orphanedProposals = db.query(
          "SELECT COUNT(*) as cnt FROM classification_proposals WHERE run_id NOT IN (SELECT id FROM classification_runs)"
        ).get() as { cnt: number };

        if (orphanedEvidence.cnt > 0) {
          db.run('DELETE FROM classification_proposal_evidence WHERE evidence_id IN (SELECT id FROM classification_evidence WHERE run_id NOT IN (SELECT id FROM classification_runs))');
          db.run('DELETE FROM classification_evidence WHERE run_id NOT IN (SELECT id FROM classification_runs)');
          console.log(`[Migrations] Cleaned up ${orphanedEvidence.cnt} orphaned classification_evidence row(s).`);
        }
        if (orphanedStageResults.cnt > 0) {
          db.run('DELETE FROM classification_stage_results WHERE run_id NOT IN (SELECT id FROM classification_runs)');
          console.log(`[Migrations] Cleaned up ${orphanedStageResults.cnt} orphaned classification_stage_results row(s).`);
        }
        if (orphanedProposals.cnt > 0) {
          db.run('DELETE FROM classification_proposal_evidence WHERE proposal_id IN (SELECT id FROM classification_proposals WHERE run_id NOT IN (SELECT id FROM classification_runs))');
          db.run('DELETE FROM classification_proposal_decisions WHERE proposal_id IN (SELECT id FROM classification_proposals WHERE run_id NOT IN (SELECT id FROM classification_runs))');
          db.run('DELETE FROM classification_proposals WHERE run_id NOT IN (SELECT id FROM classification_runs)');
          console.log(`[Migrations] Cleaned up ${orphanedProposals.cnt} orphaned classification_proposals row(s).`);
        }

        // ── Rebuild evidence table with updated CHECK ──────────────────
        db.transaction(() => {
          // Create new table with updated CHECK
          db.exec(`CREATE TABLE classification_evidence_new (
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
        )`);
          // Copy data
          db.exec('INSERT INTO classification_evidence_new SELECT * FROM classification_evidence');
          // Drop old, rename new
          db.exec('DROP TABLE classification_evidence');
          db.exec('ALTER TABLE classification_evidence_new RENAME TO classification_evidence');
          // Recreate indexes
          db.exec('CREATE INDEX IF NOT EXISTS idx_classification_evidence_run ON classification_evidence(run_id)');
          db.exec('CREATE INDEX IF NOT EXISTS idx_classification_evidence_product_source ON classification_evidence(product_sku, source)');
          db.exec('CREATE INDEX IF NOT EXISTS idx_classification_evidence_product ON classification_evidence(product_sku)');
        })();
      } finally {
        // Always restore foreign key enforcement, even if the rebuild fails
        db.exec('PRAGMA foreign_keys = ON');
      }

      // Create new indexes
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_classification_runs_one_running_catalog ON classification_runs(workspace_id, product_sku) WHERE source_kind = \'catalog_product\' AND status = \'running\'');
      db.exec('CREATE INDEX IF NOT EXISTS idx_classification_runs_workspace_sku_source_time ON classification_runs(workspace_id, product_sku, source_kind, started_at DESC)');

      // Verify the table rebuild was correct by checking row counts match.
      // Pre-existing FK violations (e.g. evidence rows with orphaned run_ids)
      // are logged as warnings but must NOT block the migration — they predate
      // this schema update.
      const evidenceFkCheck = db.query("PRAGMA foreign_key_check('classification_evidence')").all();
      if (evidenceFkCheck.length > 0) {
        console.warn(`[Migrations] ${evidenceFkCheck.length} pre-existing FK violations in classification_evidence (not caused by this migration):`, evidenceFkCheck.slice(0, 5));
      }

      const allFkCheck = db.query('PRAGMA foreign_key_check').all() as Array<{table: string}>;
      const otherViolations = allFkCheck.filter(v => v.table !== 'classification_evidence');
      if (otherViolations.length > 0) {
        console.warn(`[Migrations] ${otherViolations.length} pre-existing FK violations in other tables:`, otherViolations.slice(0, 5));
      }

      db.exec("INSERT INTO app_meta (key, value) VALUES ('catalog_classification_schema_version', '1')");
      console.log('[Migrations] Catalog classification migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Catalog classification migration failed:', e);
  }

  // ── Rename shopsite_connection to connection ────────────────────────────────
  // schema.sql creates `connection` first (CREATE IF NOT EXISTS). On an upgrade
  // DB that still has shopsite_connection, a plain RENAME collides with the
  // empty destination. Copy legacy rows into connection, then drop the old
  // table, and only then mark the migration complete.
  try {
    const connectionRenameVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('connection_rename_schema_version') as
      | { value: string }
      | undefined;
    if (!connectionRenameVersion) {
      console.log('[Migrations] Running connection table rename migration...');
      db.transaction(() => {
        const oldTables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='shopsite_connection'").all();
        const newTables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='connection'").all();

        if (oldTables.length > 0 && newTables.length === 0) {
          db.exec('ALTER TABLE shopsite_connection RENAME TO connection;');
        } else if (oldTables.length > 0 && newTables.length > 0) {
          // Destination already exists (fresh schema.sql). Merge any missing
          // legacy rows by primary key, preferring already-present connection
          // rows for the same id. Also skip legacy rows whose workspace_id is
          // already represented in connection under a different id.
          db.exec(`
            INSERT INTO connection (
              id, workspace_id, cgi_base_url, auth_strategy, merchant_id,
              password_secret_ref, last_tested_at, last_test_status, last_test_error
            )
            SELECT
              old.id, old.workspace_id, old.cgi_base_url, old.auth_strategy, old.merchant_id,
              old.password_secret_ref, old.last_tested_at, old.last_test_status, old.last_test_error
            FROM shopsite_connection AS old
            WHERE NOT EXISTS (SELECT 1 FROM connection AS cur WHERE cur.id = old.id)
              AND NOT EXISTS (SELECT 1 FROM connection AS cur WHERE cur.workspace_id = old.workspace_id)
          `);
          db.exec('DROP TABLE shopsite_connection;');
        }

        const stillOld = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='shopsite_connection'").all();
        if (stillOld.length > 0) {
          throw new Error('shopsite_connection still exists after connection rename migration');
        }
        const hasConnection = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='connection'").all();
        if (hasConnection.length === 0) {
          throw new Error('connection table missing after connection rename migration');
        }

        db.exec("INSERT INTO app_meta (key, value) VALUES ('connection_rename_schema_version', '1');");
      })();
      console.log('[Migrations] Connection table rename migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Connection table rename migration failed:', e);
    throw e;
  }

  // ── Decision Revision Migration ─────────────────────────────────────────────
  // decision_key stores an explicit user-action token. Its uniqueness spans
  // historical and live rows so a delayed retry can never reactivate an older
  // action. This repair runs on every startup (even with a version marker) to
  // fail closed if a partial deployment left the index missing or malformed.
  try {
    db.transaction(() => {
      const decCols = db.query('PRAGMA table_info(classification_proposal_decisions)').all() as Array<{ name: string }>;
      const addDecCol = (col: string, def: string) => {
        if (!decCols.some(c => c.name === col)) {
          db.exec('ALTER TABLE classification_proposal_decisions ADD COLUMN ' + col + ' ' + def);
          console.log('[Migrations] Added classification_proposal_decisions.' + col);
        }
      };

      addDecCol('revised_value_json', 'TEXT');
      addDecCol('revised_target_id', 'TEXT');
      addDecCol('has_revised_target', 'INTEGER NOT NULL DEFAULT 0');
      addDecCol('decision_key', 'TEXT');
      addDecCol('superseded_at', 'TEXT');
      addDecCol('decision_origin', 'TEXT');

      const propCols = db.query('PRAGMA table_info(classification_proposals)').all() as Array<{ name: string }>;
      const addPropCol = (col: string, def: string) => {
        if (!propCols.some(c => c.name === col)) {
          db.exec('ALTER TABLE classification_proposals ADD COLUMN ' + col + ' ' + def);
          console.log('[Migrations] Added classification_proposals.' + col);
        }
      };
      addPropCol('superseded_at', 'TEXT');
      addPropCol('refresh_queue_id', 'TEXT');

      const rqCols = db.query('PRAGMA table_info(classification_refresh_queue)').all() as Array<{ name: string }>;
      const addRqCol = (col: string, def: string) => {
        if (!rqCols.some(c => c.name === col)) {
          db.exec('ALTER TABLE classification_refresh_queue ADD COLUMN ' + col + ' ' + def);
          console.log('[Migrations] Added classification_refresh_queue.' + col);
        }
      };
      addRqCol('source_kind', "TEXT NOT NULL DEFAULT 'onboarding'");
      addRqCol('onboarding_item_id', 'TEXT');
      addRqCol('cohort_id', 'TEXT');
      addRqCol('expected_run_id', 'TEXT');
      addRqCol('expected_parent_run_id', 'TEXT');
      addRqCol('trigger_decision_id', 'TEXT');
      addRqCol('claimed_by', 'TEXT');
      addRqCol('claimed_at', 'TEXT');
      addRqCol('attempt_count', 'INTEGER NOT NULL DEFAULT 0');
      addRqCol('outcome_run_id', 'TEXT');

      // Backfill presence for rows that already stored a non-null revised target
      // before the explicit presence column existed.
      db.exec(`UPDATE classification_proposal_decisions
        SET has_revised_target = 1
        WHERE revised_target_id IS NOT NULL AND COALESCE(has_revised_target, 0) = 0`);

      // A partial version of the old live-only index could contain duplicate
      // keys on superseded rows. Keep the earliest action-token owner and clear
      // only duplicate tokens; decision rows/history remain intact.
      db.exec('DROP INDEX IF EXISTS idx_classification_decisions_key');
      const duplicateKeys = db.query(
        `SELECT decision_key FROM classification_proposal_decisions
         WHERE decision_key IS NOT NULL
         GROUP BY decision_key HAVING COUNT(*) > 1`,
      ).all() as Array<{ decision_key: string }>;
      for (const { decision_key: key } of duplicateKeys) {
        const canonical = db.query(
          `SELECT id FROM classification_proposal_decisions
           WHERE decision_key = ? ORDER BY created_at ASC, rowid ASC LIMIT 1`,
        ).get(key) as { id: string } | undefined;
        if (!canonical) throw new Error(`Unable to reconcile duplicate decision token ${key}`);
        db.run(
          'UPDATE classification_proposal_decisions SET decision_key = NULL WHERE decision_key = ? AND id != ?',
          [key, canonical.id],
        );
      }

      db.exec(`CREATE UNIQUE INDEX idx_classification_decisions_key
        ON classification_proposal_decisions(decision_key)
        WHERE decision_key IS NOT NULL`);

      const indexSql = db.query(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_classification_decisions_key'",
      ).get() as { sql: string } | undefined;
      if (!indexSql || /superseded_at/i.test(indexSql.sql)) {
        throw new Error('Decision action-token uniqueness index was not created correctly.');
      }

      db.run(
        `INSERT INTO app_meta (key, value) VALUES ('decision_revision_schema_version', '2')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      );
    })();
    console.log('[Migrations] Decision revision migration verified.');
  } catch (e) {
    console.error('[Migrations] Decision revision migration failed:', e);
    throw e;
  }

  // ── Benchmark / Evaluation Migration ─────────────────────────────────────────
  try {
    db.transaction(() => {
      // Legacy (pre-v2) shape. Kept so upgrade DBs that predate schema.sql's
      // benchmark tables still receive the old columns; the guarded
      // benchmark_v2 migration below adds the lifecycle/immutability columns.
      db.exec(`
        CREATE TABLE IF NOT EXISTS benchmark_datasets (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          holdout_strategy TEXT NOT NULL DEFAULT 'product_family',
          split_seed INTEGER NOT NULL,
          total_examples INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS benchmark_examples (
          id TEXT PRIMARY KEY,
          dataset_id TEXT NOT NULL REFERENCES benchmark_datasets(id) ON DELETE CASCADE,
          product_sku TEXT NOT NULL,
          product_family_id TEXT,
          split_group TEXT NOT NULL CHECK (split_group IN ('train', 'test', 'holdout')),
          input_snapshot_json TEXT NOT NULL,
          gold_labels_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_benchmark_examples_dataset ON benchmark_examples(dataset_id);
        CREATE INDEX IF NOT EXISTS idx_benchmark_examples_split ON benchmark_examples(dataset_id, split_group);
        CREATE TABLE IF NOT EXISTS benchmark_eval_runs (
          id TEXT PRIMARY KEY,
          dataset_id TEXT NOT NULL REFERENCES benchmark_datasets(id) ON DELETE CASCADE,
          run_label TEXT NOT NULL,
          model_config_json TEXT,
          metrics_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_benchmark_eval_runs_dataset ON benchmark_eval_runs(dataset_id);
      `);
    })();
    console.log('[Migrations] Benchmark/evaluation tables verified.');
  } catch (e) {
    console.error('[Migrations] Benchmark migration failed:', e);
    throw e;
  }

  // ── Benchmark V2 Migration (frozen Gold + prediction bundles) ────────────────
  {
    const benchmarkV2Version = db.query('SELECT value FROM app_meta WHERE key = ?').get('benchmark_v2_schema_version') as
      | { value: string }
      | undefined;
    if (!benchmarkV2Version) {
      console.log('[Migrations] Running benchmark v2 migration...');
      db.transaction(() => {
        const hasColumn = (table: string, column: string): boolean => {
          const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
          return cols.some(c => c.name === column);
        };

        // datasets: lifecycle columns.
        if (!hasColumn('benchmark_datasets', 'status')) {
          db.exec("ALTER TABLE benchmark_datasets ADD COLUMN status TEXT NOT NULL DEFAULT 'draft';");
        }
        if (!hasColumn('benchmark_datasets', 'family_review_complete')) {
          db.exec('ALTER TABLE benchmark_datasets ADD COLUMN family_review_complete INTEGER NOT NULL DEFAULT 0;');
        }
        if (!hasColumn('benchmark_datasets', 'family_reviewed_by')) db.exec('ALTER TABLE benchmark_datasets ADD COLUMN family_reviewed_by TEXT;');
        if (!hasColumn('benchmark_datasets', 'family_reviewed_at')) db.exec('ALTER TABLE benchmark_datasets ADD COLUMN family_reviewed_at TEXT;');
        if (!hasColumn('benchmark_datasets', 'dataset_hash')) db.exec('ALTER TABLE benchmark_datasets ADD COLUMN dataset_hash TEXT;');
        if (!hasColumn('benchmark_datasets', 'frozen_at')) db.exec('ALTER TABLE benchmark_datasets ADD COLUMN frozen_at TEXT;');
        if (!hasColumn('benchmark_datasets', 'frozen_by')) db.exec('ALTER TABLE benchmark_datasets ADD COLUMN frozen_by TEXT;');
        if (!hasColumn('benchmark_datasets', 'retired_at')) db.exec('ALTER TABLE benchmark_datasets ADD COLUMN retired_at TEXT;');
        if (!hasColumn('benchmark_datasets', 'source_config_hash')) db.exec('ALTER TABLE benchmark_datasets ADD COLUMN source_config_hash TEXT;');

        // examples: immutability/provenance columns.
        if (!hasColumn('benchmark_examples', 'example_hash')) db.exec('ALTER TABLE benchmark_examples ADD COLUMN example_hash TEXT;');
        if (!hasColumn('benchmark_examples', 'reviewer_id')) db.exec('ALTER TABLE benchmark_examples ADD COLUMN reviewer_id TEXT;');
        if (!hasColumn('benchmark_examples', 'adjudicated_by')) db.exec('ALTER TABLE benchmark_examples ADD COLUMN adjudicated_by TEXT;');
        if (!hasColumn('benchmark_examples', 'source_run_id')) db.exec('ALTER TABLE benchmark_examples ADD COLUMN source_run_id TEXT;');
        if (!hasColumn('benchmark_examples', 'source_config_hash')) db.exec('ALTER TABLE benchmark_examples ADD COLUMN source_config_hash TEXT;');
        if (!hasColumn('benchmark_examples', 'source_product_hash')) db.exec('ALTER TABLE benchmark_examples ADD COLUMN source_product_hash TEXT;');

        // eval_runs: bind evaluations to the persisted prediction bundle.
        if (!hasColumn('benchmark_eval_runs', 'prediction_bundle_id')) {
          db.exec('ALTER TABLE benchmark_eval_runs ADD COLUMN prediction_bundle_id TEXT;');
        }

        // Backfill example_hash for pre-existing rows (deterministic and
        // idempotent — matches the repository's insert-time hash domain).
        const hasFamilyColumn = hasColumn('benchmark_examples', 'product_family_id');
        const legacyExamples = db.query(
          hasFamilyColumn
            ? 'SELECT id, product_sku, product_family_id, split_group, input_snapshot_json, gold_labels_json FROM benchmark_examples'
            : 'SELECT id, product_sku, split_group, input_snapshot_json, gold_labels_json FROM benchmark_examples',
        ).all() as Array<{
          id: string;
          product_sku: string;
          product_family_id: string | null;
          split_group: string;
          input_snapshot_json: string;
          gold_labels_json: string;
        }>;
        const backfillHash = (row: { product_sku: string; product_family_id: string | null; split_group: string; input_snapshot_json: string; gold_labels_json: string }): string => {
          return sha256Hex(JSON.stringify({
            productSku: row.product_sku,
            productFamilyId: row.product_family_id,
            splitGroup: row.split_group,
            inputSnapshotJson: row.input_snapshot_json,
            goldLabelsJson: row.gold_labels_json,
            sourceRunId: null,
            sourceConfigHash: null,
            sourceProductHash: null,
          }));
        };
        for (const example of legacyExamples) {
          const existing = db.query('SELECT example_hash FROM benchmark_examples WHERE id = ?').get(example.id) as { example_hash: string | null } | undefined;
          if (!existing || !existing.example_hash) {
            db.query('UPDATE benchmark_examples SET example_hash = ? WHERE id = ?').run(backfillHash(example), example.id);
          }
        }

        // Prediction bundles + qualification receipts (new tables).
        db.exec(`
          CREATE TABLE IF NOT EXISTS benchmark_prediction_bundles (
            id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL REFERENCES benchmark_datasets(id) ON DELETE CASCADE,
            workspace_id TEXT NOT NULL,
            run_label TEXT NOT NULL,
            split_group TEXT NOT NULL CHECK (split_group IN ('test', 'holdout')),
            predictions_json TEXT NOT NULL,
            bundle_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_benchmark_prediction_bundles_dataset ON benchmark_prediction_bundles(dataset_id);
          CREATE TABLE IF NOT EXISTS benchmark_qualification_receipts (
            id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL REFERENCES benchmark_datasets(id) ON DELETE CASCADE,
            dataset_hash TEXT NOT NULL,
            prediction_bundle_id TEXT NOT NULL,
            bundle_hash TEXT NOT NULL,
            holdout_size INTEGER NOT NULL,
            coverage REAL NOT NULL,
            min_class_support INTEGER NOT NULL,
            violation_counts_json TEXT NOT NULL,
            primary_metric TEXT NOT NULL,
            delta_lower95 REAL NOT NULL,
            non_regression_floors_met INTEGER NOT NULL DEFAULT 0,
            qualified INTEGER NOT NULL DEFAULT 0,
            reasons_json TEXT NOT NULL,
            digest TEXT NOT NULL,
            generated_at TEXT NOT NULL,
            generated_by TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_benchmark_qualification_receipts_dataset ON benchmark_qualification_receipts(dataset_id);
          CREATE INDEX IF NOT EXISTS idx_benchmark_qualification_receipts_digest ON benchmark_qualification_receipts(digest);
          CREATE INDEX IF NOT EXISTS idx_benchmark_datasets_workspace ON benchmark_datasets(workspace_id);
        `);
      })();
      db.exec("INSERT INTO app_meta (key, value) VALUES ('benchmark_v2_schema_version', '1');");
      console.log('[Migrations] Benchmark v2 migration complete.');
    }
  }


  // ── Product Embeddings Migration ──────────────────────────────────────────
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS product_embeddings (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          product_sku TEXT NOT NULL,
          embedding_model TEXT NOT NULL,
          embedding_text TEXT NOT NULL,
          embedding_blob BLOB NOT NULL,
          embedding_dim INTEGER NOT NULL,
          source_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_product_embeddings_unique
          ON product_embeddings(workspace_id, product_sku, embedding_model);
        CREATE INDEX IF NOT EXISTS idx_product_embeddings_workspace
          ON product_embeddings(workspace_id, embedding_model);
      `);
    })();
    console.log('[Migrations] Product embeddings table verified.');
  } catch (e) {
    console.error('[Migrations] Product embeddings migration failed:', e);
    throw e;
  }

  // ── Embedding v2 schema (namespace / fingerprint / failure status) ────────
  try {
    const embeddingV2Version = db.query("SELECT value FROM app_meta WHERE key = 'embedding_v2_schema_version'").get() as
      | { value: string }
      | undefined;
    if (!embeddingV2Version || embeddingV2Version.value !== '2') {
      console.log('[Migrations] Running embedding v2 schema migration...');
      db.transaction(() => {
        const hasColumn = (table: string, column: string): boolean => {
          const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
          return cols.some(c => c.name === column);
        };
        if (!hasColumn('product_embeddings', 'provider')) {
          db.exec("ALTER TABLE product_embeddings ADD COLUMN provider TEXT NOT NULL DEFAULT 'ollama';");
        }
        if (!hasColumn('product_embeddings', 'schema_version')) {
          db.exec('ALTER TABLE product_embeddings ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;');
        }
        if (!hasColumn('product_embeddings', 'namespace')) {
          db.exec("ALTER TABLE product_embeddings ADD COLUMN namespace TEXT NOT NULL DEFAULT 'production';");
        }
        if (!hasColumn('product_embeddings', 'failure_status')) {
          db.exec('ALTER TABLE product_embeddings ADD COLUMN failure_status TEXT;');
        }
        if (!hasColumn('product_embeddings', 'source_config_hash')) {
          db.exec('ALTER TABLE product_embeddings ADD COLUMN source_config_hash TEXT;');
        }
        if (!hasColumn('product_embeddings', 'decision_run_id')) {
          db.exec('ALTER TABLE product_embeddings ADD COLUMN decision_run_id TEXT;');
        }
        if (!hasColumn('product_embeddings', 'updated_at')) {
          db.exec('ALTER TABLE product_embeddings ADD COLUMN updated_at TEXT;');
        }
        if (!hasColumn('product_embeddings', 'model_fingerprint')) {
          db.exec("ALTER TABLE product_embeddings ADD COLUMN model_fingerprint TEXT NOT NULL DEFAULT '';");
        }
        if (!hasColumn('product_embeddings', 'document_hash')) {
          db.exec('ALTER TABLE product_embeddings ADD COLUMN document_hash TEXT;');
        }
        if (!hasColumn('product_embeddings', 'config_hash')) {
          db.exec('ALTER TABLE product_embeddings ADD COLUMN config_hash TEXT;');
        }
        if (!hasColumn('product_embeddings', 'decision_hash')) {
          db.exec('ALTER TABLE product_embeddings ADD COLUMN decision_hash TEXT;');
        }
        if (!hasColumn('product_embeddings', 'run_id')) {
          db.exec('ALTER TABLE product_embeddings ADD COLUMN run_id TEXT;');
        }
        // Namespace-aware uniqueness replaces the legacy 3-column unique index
        // so the same SKU+model can exist in both namespaces.
        db.exec('DROP INDEX IF EXISTS idx_product_embeddings_unique;');
        db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_product_embeddings_unique
            ON product_embeddings(workspace_id, product_sku, embedding_model, namespace);
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_product_embeddings_namespace
            ON product_embeddings(workspace_id, namespace, embedding_model);
        `);
      })();
      db.exec(`INSERT INTO app_meta (key, value) VALUES ('embedding_v2_schema_version', '2')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;`);
      console.log('[Migrations] Embedding v2 schema migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Embedding v2 schema migration failed:', e);
    throw e;
  }

  // ── Page Identity Migration ────────────────────────────────────────────────
  //
  // Demotes all synthetic/local Page rows to `unverified_name_only` review
  // context, drops the UNIQUE(name) identity assumption, adds workspace/import
  // provenance and identity columns, clears inferred product_pages.page_id
  // references (preserving names and assignment history), and marks
  // category_page proposals referencing inferred identities stale without
  // deleting decisions. A real ShopSite Pages export is required before any
  // row can become a verified identity.
  try {
    const pageIdentityVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('page_identity_schema_version') as
      | { value: string }
      | undefined;
    if (!pageIdentityVersion) {
      console.log('[Migrations] Running page identity migration...');
      // PRAGMA foreign_keys cannot be toggled inside a transaction (SQLite
      // silently ignores it), so the historical OFF/ON pair around the table
      // rebuild was a no-op whenever foreign_keys was ON. Capture the current
      // state, toggle OFF BEFORE the rebuild transaction (so DROP TABLE on a
      // table referenced by FK constraints is permitted), and restore the
      // captured state after it completes.
      const fkRow = db.query('PRAGMA foreign_keys').get() as { foreign_keys: number } | undefined;
      const fkWasOn = fkRow ? Number(fkRow.foreign_keys) === 1 : false;
      if (fkWasOn) db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.transaction(() => {
        // 1. page_imports table (previewed imports are never stored; only
        //    activations persist, so this table is the verified-import audit).
        db.exec(`
          CREATE TABLE IF NOT EXISTS page_imports (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            source_hash TEXT NOT NULL,
            parser_format_version TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('previewed', 'active', 'superseded')),
            counts_json TEXT NOT NULL,
            records_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            activated_at TEXT,
            superseded_at TEXT,
            activated_by TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_page_imports_workspace_status ON page_imports(workspace_id, status);
        `);

        // 2. Add page_index provenance/identity columns when missing.
        const pageCols = db.query('PRAGMA table_info(page_index)').all() as Array<{ name: string }>;
        const pageHas = (name: string) => pageCols.some(c => c.name === name);
        if (!pageHas('workspace_id')) db.exec('ALTER TABLE page_index ADD COLUMN workspace_id TEXT;');
        if (!pageHas('import_id')) db.exec('ALTER TABLE page_index ADD COLUMN import_id TEXT REFERENCES page_imports(id);');
        if (!pageHas('identity_kind')) db.exec("ALTER TABLE page_index ADD COLUMN identity_kind TEXT NOT NULL DEFAULT 'unverified_name_only';");
        if (!pageHas('identity_key')) db.exec('ALTER TABLE page_index ADD COLUMN identity_key TEXT;');
        if (!pageHas('identity_status')) db.exec("ALTER TABLE page_index ADD COLUMN identity_status TEXT NOT NULL DEFAULT 'unverified';");
        if (!pageHas('source_hash')) db.exec('ALTER TABLE page_index ADD COLUMN source_hash TEXT;');
        if (!pageHas('availability')) db.exec("ALTER TABLE page_index ADD COLUMN availability TEXT NOT NULL DEFAULT 'unavailable';");
        if (!pageHas('review_status')) db.exec("ALTER TABLE page_index ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending';");

        // 3. Rebuild page_index to drop the UNIQUE(name) constraint. A name is
        //    never an identity key — duplicate names must be representable.
        const pageIndexSql = db.query(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'page_index'",
        ).get() as { sql: string } | undefined;
        if (pageIndexSql && /UNIQUE/i.test(pageIndexSql.sql)) {
          db.exec(`
              CREATE TABLE page_index_new (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                file_name TEXT,
                parent_id TEXT REFERENCES page_index(id),
                page_hash TEXT NOT NULL,
                workspace_id TEXT,
                import_id TEXT REFERENCES page_imports(id),
                identity_kind TEXT NOT NULL DEFAULT 'unverified_name_only',
                identity_key TEXT,
                identity_status TEXT NOT NULL DEFAULT 'unverified',
                source_hash TEXT,
                availability TEXT NOT NULL DEFAULT 'unavailable',
                review_status TEXT NOT NULL DEFAULT 'pending',
                last_synced_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
              )
            `);
            db.exec(`
              INSERT INTO page_index_new (
                id, name, file_name, parent_id, page_hash, workspace_id, import_id,
                identity_kind, identity_key, identity_status, source_hash, availability,
                review_status, last_synced_at, created_at, updated_at
              )
              SELECT
                id, name, file_name, parent_id, page_hash, workspace_id, import_id,
                identity_kind, identity_key, identity_status, source_hash, availability,
                review_status, last_synced_at, created_at, updated_at
              FROM page_index
            `);
            db.exec('DROP TABLE page_index;');
            db.exec('ALTER TABLE page_index_new RENAME TO page_index;');
        }
        db.exec('CREATE INDEX IF NOT EXISTS idx_page_index_name ON page_index(name);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_page_index_identity ON page_index(workspace_id, identity_kind, identity_key);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_page_index_import ON page_index(import_id);');

        // 4. Backfill legacy rows: every existing row is name-only review
        //    context with no verified identity. Names are preserved.
        db.exec(
          'UPDATE page_index SET identity_key = name WHERE identity_key IS NULL AND name IS NOT NULL',
        );
        db.exec(
          'UPDATE page_index SET workspace_id = (SELECT id FROM workspace ORDER BY rowid ASC LIMIT 1) WHERE workspace_id IS NULL',
        );
        db.exec(`
          UPDATE page_index SET
            identity_kind = 'unverified_name_only',
            identity_status = 'unverified',
            availability = 'unavailable',
            review_status = 'pending',
            source_hash = COALESCE(source_hash, page_hash)
          WHERE identity_kind = 'unverified_name_only' OR identity_status = 'unverified' OR identity_kind IS NULL
        `);

        // 5. Clear inferred product_pages.page_id references while preserving
        //    the rows (names and assignment history survive; the FK is unset).
        db.exec('UPDATE product_pages SET page_id = NULL WHERE page_id IS NOT NULL');

        // 6. Mark category_page proposals referencing inferred identities stale
        //    without deleting proposals or their decision history.
        const staleCount = db.run(
          `UPDATE classification_proposals SET status = 'stale', is_stale = 1, staleness_reason = 'page_identity_unverified'
           WHERE proposal_type = 'category_page' AND status IN ('pending', 'accepted', 'deferred')`,
        ).changes;
        console.log(`[Migrations] Marked ${staleCount} category_page proposal(s) stale (page identity unverified).`);

        db.exec("INSERT INTO app_meta (key, value) VALUES ('page_identity_schema_version', '1');");
        console.log('[Migrations] Page identity migration complete.');
        })();
      } finally {
        if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
      }
    }
  } catch (e) {
    console.error('[Migrations] Page identity migration failed:', e);
    throw e;
  }

  // Unique verified-identity index: a name is never an identity key, and each
  // (workspace, import, identity kind, identity key) tuple is unique. Created
  // outside the guarded page_identity block (idempotent) so databases that
  // already ran that migration still get the index. The in-code capture check
  // rejects duplicates even where this index cannot be created.
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_page_index_identity_unique ON page_index(workspace_id, import_id, identity_kind, identity_key);',
  );

  // ── Classification model-call provenance (issue #17 work item E) ──────────
  //
  // Durable per-call observability for protected model calls bound to
  // classification runs: `classification_model_calls` (started → terminal on
  // every path) and the `model_call_ids_json` column on proposals so a
  // proposal can be traced to the exact calls that produced it. Legacy
  // `curation_model_calls` is deprecated and untouched. Idempotent; guarded by
  // `model_calls_schema_version`.
  try {
    const modelCallsVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('model_calls_schema_version') as
      | { value: string }
      | undefined;
    if (!modelCallsVersion) {
      console.log('[Migrations] Running classification model-call provenance migration...');
      db.exec(`
        CREATE TABLE IF NOT EXISTS classification_model_calls (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES classification_runs(id) ON DELETE CASCADE,
          stage_name TEXT,
          operation TEXT NOT NULL,
          attempt INTEGER NOT NULL DEFAULT 1,
          provider TEXT,
          model TEXT,
          locality TEXT,
          snapshot_hash TEXT,
          model_policy_digest TEXT,
          prompt_template_version TEXT,
          rule_version TEXT,
          system_prompt_hash TEXT,
          user_prompt_hash TEXT,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          duration_ms INTEGER,
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          status TEXT NOT NULL CHECK (status IN ('started', 'success', 'failed', 'policy_denied', 'unavailable', 'cancelled')),
          error_message TEXT,
          estimated_cost_usd REAL,
          cost_basis TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_classification_model_calls_run ON classification_model_calls(run_id);
        CREATE INDEX IF NOT EXISTS idx_classification_model_calls_snapshot ON classification_model_calls(snapshot_hash);
      `);
      const proposalColumns = db.query('PRAGMA table_info(classification_proposals)').all() as Array<{ name: string }>;
      if (!proposalColumns.some(col => col.name === 'model_call_ids_json')) {
        db.exec('ALTER TABLE classification_proposals ADD COLUMN model_call_ids_json TEXT;');
      }
      db.exec("INSERT INTO app_meta (key, value) VALUES ('model_calls_schema_version', '1');");
      console.log('[Migrations] Classification model-call provenance migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Classification model-call provenance migration failed:', e);
    throw e;
  }

  // Issue #17 work items H + I: target-specific evidence relations and
  // reviewer-correction evidence citations.
  // - classification_proposal_evidence gains the authoritative `relation`
  //   column (supporting/contradicting/context; legacy rows default to
  //   'legacy' — run-wide unions written before relations existed).
  // - classification_proposal_decision_evidence stores append-only citations
  //   per reviewer decision (FKs, PK (decision_id, evidence_id)).
  // - classification_proposals gains supporting/contradicting JSON columns so
  //   proposals hydrate with the authoritative role split.
  // Idempotent; guarded by `evidence_citation_schema_version`.
  try {
    const cols = (tbl: string) => db.query('PRAGMA table_info(' + tbl + ')').all() as Array<{ name: string }>;
    const evidenceCitationVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('evidence_citation_schema_version') as
      | { value: string }
      | undefined;
    if (!evidenceCitationVersion) {
      console.log('[Migrations] Running evidence relation/citation migration...');
      const addCol = (tbl: string, col: string, def: string) => {
        if (!cols(tbl).some((c: { name: string }) => c.name === col)) {
          db.exec('ALTER TABLE ' + tbl + ' ADD COLUMN ' + col + ' ' + def);
          console.log('[Migrations] Added ' + tbl + '.' + col);
        }
      };

      // Authoritative evidence-role column on the proposal-evidence join.
      if (!cols('classification_proposal_evidence').some(c => c.name === 'relation')) {
        db.exec(`ALTER TABLE classification_proposal_evidence ADD COLUMN relation TEXT NOT NULL DEFAULT 'legacy'`);
        console.log('[Migrations] Added classification_proposal_evidence.relation');
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_classification_proposal_evidence_relation ON classification_proposal_evidence(relation);");

      // Append-only reviewer-correction citations.
      db.exec(`
        CREATE TABLE IF NOT EXISTS classification_proposal_decision_evidence (
          decision_id TEXT NOT NULL REFERENCES classification_proposal_decisions(id) ON DELETE CASCADE,
          evidence_id TEXT NOT NULL REFERENCES classification_evidence(id) ON DELETE CASCADE,
          PRIMARY KEY (decision_id, evidence_id)
        );
        CREATE INDEX IF NOT EXISTS idx_classification_decision_evidence_decision ON classification_proposal_decision_evidence(decision_id);
      `);

      // Role-split hydration columns on proposals (mirror the union column).
      // NOT NULL DEFAULT '[]' so upgrade columns match the fresh schema; a
      // backfill below covers any nullable column from an earlier migration.
      addCol('classification_proposals', 'supporting_evidence_ids_json', "TEXT NOT NULL DEFAULT '[]'");
      addCol('classification_proposals', 'contradicting_evidence_ids_json', "TEXT NOT NULL DEFAULT '[]'");

      // Backfill any nullable role columns left by an earlier migration run.
      db.exec("UPDATE classification_proposals SET supporting_evidence_ids_json = '[]' WHERE supporting_evidence_ids_json IS NULL;");
      db.exec("UPDATE classification_proposals SET contradicting_evidence_ids_json = '[]' WHERE contradicting_evidence_ids_json IS NULL;");

      db.exec("INSERT INTO app_meta (key, value) VALUES ('evidence_citation_schema_version', '1');");
      console.log('[Migrations] Evidence relation/citation migration complete.');
    }

    // Upgrade parity (runs on EVERY migration invocation, even when the
    // evidence-citation marker is already set): the join table must carry the
    // same relation CHECK as the fresh schema. SQLite cannot add CHECK via
    // ALTER, so rebuild the (small) join table when the CHECK is absent — for
    // DBs that ran an earlier version of this migration with a CHECK-less
    // ALTER-added relation column.
    const propEvCols = cols('classification_proposal_evidence');
    if (propEvCols.length > 0 && !propEvCols.some(c => c.name === 'relation')) {
      db.exec(`ALTER TABLE classification_proposal_evidence ADD COLUMN relation TEXT NOT NULL DEFAULT 'legacy'`);
      console.log('[Migrations] Added classification_proposal_evidence.relation');
    }

    const proposalEvidenceSql = db.query(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'classification_proposal_evidence'",
    ).get() as { sql: string } | undefined;
    if (proposalEvidenceSql && !/CHECK\s*\(/i.test(proposalEvidenceSql.sql)) {
      const liveCols = cols('classification_proposal_evidence').map(c => c.name);
      const relationExpr = liveCols.includes('relation') ? "COALESCE(relation, 'legacy')" : "'legacy'";
      const fkRow = db.query('PRAGMA foreign_keys').get() as { foreign_keys: number } | undefined;
      const fkWasOn = fkRow ? Number(fkRow.foreign_keys) === 1 : false;
      if (fkWasOn) db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.exec(`
          CREATE TABLE classification_proposal_evidence_new (
            proposal_id TEXT NOT NULL REFERENCES classification_proposals(id) ON DELETE CASCADE,
            evidence_id TEXT NOT NULL REFERENCES classification_evidence(id) ON DELETE CASCADE,
            relation TEXT NOT NULL DEFAULT 'legacy' CHECK (relation IN ('supporting', 'contradicting', 'context', 'legacy')),
            PRIMARY KEY (proposal_id, evidence_id)
          )
        `);
        db.exec(`
          INSERT INTO classification_proposal_evidence_new (proposal_id, evidence_id, relation)
          SELECT proposal_id, evidence_id, ${relationExpr}
          FROM classification_proposal_evidence
        `);
        db.exec('DROP TABLE classification_proposal_evidence;');
        db.exec('ALTER TABLE classification_proposal_evidence_new RENAME TO classification_proposal_evidence;');
      } finally {
        if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_classification_proposal_evidence_relation ON classification_proposal_evidence(relation);');
      console.log('[Migrations] Rebuilt classification_proposal_evidence with the relation CHECK constraint.');
    }

    // Upgrade parity for classification_proposals role columns (runs on EVERY
    // migration invocation, even when evidence_citation_schema_version is set):
    // SQLite cannot change an existing column's NOT NULL constraint via ALTER,
    // so rebuild the proposals table whenever any role column is still
    // nullable (a DB that ran an earlier evidence-citation migration). The
    // live CREATE TABLE SQL is patched to force all three role columns to
    // NOT NULL DEFAULT '[]'; every other column, constraint, and row is
    // preserved. No-op when the columns are already correct.
    const proposalCols = db.query('PRAGMA table_info(classification_proposals)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    const roleCols = ['evidence_ids_json', 'supporting_evidence_ids_json', 'contradicting_evidence_ids_json'];
    const needsProposalRebuild = roleCols.some(name => {
      const col = proposalCols.find(c => c.name === name);
      return col !== undefined && col.notnull === 0;
    });
    if (needsProposalRebuild) {
      const proposalsSql = db.query(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'classification_proposals'",
      ).get() as { sql: string } | undefined;
      if (proposalsSql) {
        let patched = proposalsSql.sql;
        for (const name of roleCols) {
          // Replace each role column's definition with the strict form,
          // regardless of the earlier migration's column shape.
          patched = patched.replace(
            new RegExp(`(\\b${name}\\s+)[^,)]*`),
            `$1TEXT NOT NULL DEFAULT '[]'`,
          );
        }
        // Point the rebuilt DDL at a staging table name so the established
        // CREATE-new → copy → drop-old → rename pattern applies (the same
        // pattern as the page_index rebuild). Handles both 'CREATE TABLE
        // classification_proposals' and 'CREATE TABLE IF NOT EXISTS
        // classification_proposals' forms stored in sqlite_master.
        patched = patched.replace(
          /CREATE TABLE (?:IF NOT EXISTS )?classification_proposals\b/,
          'CREATE TABLE classification_proposals_new',
        );
        const fkRow = db.query('PRAGMA foreign_keys').get() as { foreign_keys: number } | undefined;
        const fkWasOn = fkRow ? Number(fkRow.foreign_keys) === 1 : false;
        if (fkWasOn) db.exec('PRAGMA foreign_keys = OFF');
        try {
          db.transaction(() => {
            db.exec(patched);
            // Copy ONLY the columns that exist in the live table (upgrade DBs
            // may predate some columns, e.g. model_call_ids_json). Nullable
            // role columns are COALESCE'd to '[]'.
            const liveCols = db.query('PRAGMA table_info(classification_proposals)').all() as Array<{ name: string }>;
            const copyCols = liveCols.map(c => c.name);
            const roleColumnSet = new Set(roleCols);
            const insertList = copyCols.map(name => `"${name}"`).join(', ');
            const selectList = copyCols
              .map(name => (roleColumnSet.has(name) ? `COALESCE("${name}", '[]')` : `"${name}"`))
              .join(', ');
            db.exec(`
              INSERT INTO classification_proposals_new (${insertList})
              SELECT ${selectList}
              FROM classification_proposals
            `);
            db.exec('DROP TABLE classification_proposals;');
            db.exec('ALTER TABLE classification_proposals_new RENAME TO classification_proposals;');
          })();
        } finally {
          if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
        }
        db.exec('CREATE INDEX IF NOT EXISTS idx_classification_proposals_run ON classification_proposals(run_id);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_classification_proposals_product_status ON classification_proposals(product_sku, status);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_classification_proposals_product ON classification_proposals(product_sku);');
        console.log('[Migrations] Rebuilt classification_proposals with NOT NULL role columns.');
      }
    }
  } catch (e) {
    console.error('[Migrations] Evidence relation/citation migration failed:', e);
    throw e;
  }

  // ── Product Intelligence Migration (PI-2) ──────────────────────────────────
  //
  // Durable data model for Product Intelligence runs (epic #28, issue #19):
  // runs, the replayable event stream, steps, tool calls, sources, evidence,
  // conflicts, results, and Pi-vs-baseline comparisons. Normalized tables are
  // authoritative; onboarding imports reference the originating run and
  // selected evidence. Child rows cascade on run deletion (explicit retention
  // policy lives in the run service).
  try {
    const piVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('product_intelligence_schema_version') as
      | { value: string }
      | undefined;
    if (!piVersion) {
      console.log('[Migrations] Running product intelligence schema migration...');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS product_intelligence_runs (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspace(id),
            onboarding_item_id TEXT,
            mode TEXT NOT NULL DEFAULT 'interactive' CHECK (mode IN ('shadow', 'interactive', 'onboarding')),
            status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
            executor TEXT NOT NULL,
            input_json TEXT NOT NULL,
            policy_json TEXT NOT NULL,
            config_snapshot_id TEXT NOT NULL,
            config_snapshot_hash TEXT NOT NULL,
            code_commit TEXT,
            pi_version TEXT,
            extension_versions_json TEXT NOT NULL DEFAULT '[]',
            started_at TEXT NOT NULL,
            completed_at TEXT,
            cancelled_at TEXT,
            error_code TEXT,
            error_message TEXT,
            estimated_cost REAL,
            actual_cost REAL,
            token_usage_json TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_pi_runs_workspace_status ON product_intelligence_runs(workspace_id, status);
          CREATE INDEX IF NOT EXISTS idx_pi_runs_started ON product_intelligence_runs(started_at);

          CREATE TABLE IF NOT EXISTS product_intelligence_events (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL,
            type TEXT NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            UNIQUE (run_id, sequence)
          );
          CREATE INDEX IF NOT EXISTS idx_pi_events_run ON product_intelligence_events(run_id, sequence);

          CREATE TABLE IF NOT EXISTS product_intelligence_steps (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
            step_type TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
            summary TEXT,
            input_hash TEXT,
            output_ref TEXT,
            started_at TEXT NOT NULL,
            completed_at TEXT,
            error_json TEXT,
            UNIQUE (run_id, sequence)
          );
          CREATE INDEX IF NOT EXISTS idx_pi_steps_run ON product_intelligence_steps(run_id, sequence);

          CREATE TABLE IF NOT EXISTS product_intelligence_tool_calls (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
            step_id TEXT REFERENCES product_intelligence_steps(id) ON DELETE SET NULL,
            sequence INTEGER NOT NULL,
            tool_name TEXT NOT NULL,
            tool_version TEXT,
            policy_outcome TEXT NOT NULL DEFAULT 'allowed' CHECK (policy_outcome IN ('allowed', 'denied', 'budget_exceeded')),
            request_hash TEXT,
            response_hash TEXT,
            artifact_ref TEXT,
            latency_ms INTEGER,
            cost_usd REAL,
            started_at TEXT NOT NULL,
            completed_at TEXT,
            error_json TEXT,
            UNIQUE (run_id, sequence)
          );
          CREATE INDEX IF NOT EXISTS idx_pi_tool_calls_run ON product_intelligence_tool_calls(run_id, sequence);

          CREATE TABLE IF NOT EXISTS product_intelligence_sources (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
            url TEXT NOT NULL,
            canonical_url TEXT,
            domain TEXT NOT NULL,
            source_type TEXT NOT NULL DEFAULT 'other' CHECK (source_type IN ('catalog', 'supplier', 'registry', 'retailer', 'manufacturer', 'other')),
            gtin_match_status TEXT NOT NULL DEFAULT 'unknown' CHECK (gtin_match_status IN ('exact', 'variant', 'unknown', 'conflicting')),
            variant_match_status TEXT NOT NULL DEFAULT 'unknown' CHECK (variant_match_status IN ('exact', 'variant', 'unknown', 'conflicting')),
            retrieved_at TEXT,
            content_hash TEXT,
            artifact_ref TEXT,
            license_ref TEXT,
            terms_ref TEXT,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_pi_sources_run ON product_intelligence_sources(run_id);

          CREATE TABLE IF NOT EXISTS product_intelligence_evidence (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
            source_id TEXT NOT NULL REFERENCES product_intelligence_sources(id) ON DELETE CASCADE,
            target_field TEXT NOT NULL,
            value_json TEXT NOT NULL,
            extraction_method TEXT,
            source_field TEXT,
            reliability TEXT,
            direct_support INTEGER NOT NULL DEFAULT 0,
            snippet TEXT,
            metadata_json TEXT,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_pi_evidence_run ON product_intelligence_evidence(run_id);
          CREATE INDEX IF NOT EXISTS idx_pi_evidence_source ON product_intelligence_evidence(source_id);

          CREATE TABLE IF NOT EXISTS product_intelligence_conflicts (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
            field TEXT NOT NULL,
            severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
            status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
            competing_values_json TEXT NOT NULL DEFAULT '[]',
            evidence_ids_json TEXT NOT NULL DEFAULT '[]',
            resolution_json TEXT,
            resolved_by TEXT,
            resolved_at TEXT,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_pi_conflicts_run ON product_intelligence_conflicts(run_id);

          CREATE TABLE IF NOT EXISTS product_intelligence_results (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL UNIQUE REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
            schema_version INTEGER NOT NULL,
            disposition TEXT NOT NULL CHECK (disposition IN ('submitted', 'abstained', 'unavailable')),
            result_json TEXT NOT NULL,
            result_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS product_intelligence_comparisons (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
            baseline_type TEXT NOT NULL,
            baseline_ref TEXT NOT NULL,
            metrics_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_pi_comparisons_run ON product_intelligence_comparisons(run_id);
        `);
      })();
      db.exec("INSERT INTO app_meta (key, value) VALUES ('product_intelligence_schema_version', '1');");
      console.log('[Migrations] Product intelligence schema migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Product intelligence schema migration failed:', e);
    throw e;
  }

  // ── Product Intelligence Policy Migration (PI-5) ──────────────────────────
  // Policy gateway audit trail (every external/model/budget decision) and the
  // prompt hash captured with each run's immutable snapshot.
  try {
    const piPolicyVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('product_intelligence_policy_schema_version') as
      | { value: string }
      | undefined;
    if (!piPolicyVersion) {
      console.log('[Migrations] Running product intelligence policy schema migration...');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS product_intelligence_policy_decisions (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
            sequence INTEGER NOT NULL,
            decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
            policy_version TEXT NOT NULL,
            target_type TEXT NOT NULL CHECK (target_type IN ('model', 'network', 'budget', 'tool')),
            target TEXT NOT NULL,
            data_classification TEXT,
            fallback_status TEXT NOT NULL DEFAULT 'none' CHECK (fallback_status IN ('none', 'fallback_denied', 'fallback_used')),
            reason_code TEXT NOT NULL,
            detail_json TEXT,
            created_at TEXT NOT NULL,
            UNIQUE (run_id, sequence)
          );
          CREATE INDEX IF NOT EXISTS idx_pi_policy_decisions_run ON product_intelligence_policy_decisions(run_id, sequence);
        `);
        const runCols = db.query('PRAGMA table_info(product_intelligence_runs)').all() as Array<{ name: string }>;
        if (!runCols.some((col) => col.name === 'prompt_hash')) {
          db.exec('ALTER TABLE product_intelligence_runs ADD COLUMN prompt_hash TEXT;');
        }
      })();
      db.exec("INSERT INTO app_meta (key, value) VALUES ('product_intelligence_policy_schema_version', '1');");
      console.log('[Migrations] Product intelligence policy schema migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Product intelligence policy schema migration failed:', e);
    throw e;
  }

  // ── Product Intelligence Asset Migration (PI-6) ───────────────────────────
  // Durable image-asset evidence records (exact-product/variant identity,
  // source + rights provenance, content + perceptual hashes, quality, and the
  // deterministic commerce-approval flag). Image provenance persists with the
  // run; onboarding import and draft-promotion consumption of approved asset
  // records is wired in a later issue (Agent Lab imports).
  try {
    const piAssetsVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('product_intelligence_assets_schema_version') as
      | { value: string }
      | undefined;
    if (!piAssetsVersion) {
      console.log('[Migrations] Running product intelligence asset schema migration...');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS product_intelligence_assets (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
            source_id TEXT REFERENCES product_intelligence_sources(id) ON DELETE SET NULL,
            source_url TEXT NOT NULL,
            source_page_url TEXT,
            source_type TEXT NOT NULL,
            source_path TEXT,
            source_artifact_id TEXT,
            extraction_method TEXT NOT NULL CHECK (extraction_method IN ('json_ld', 'platform_api', 'network_response', 'profile_selector', 'media_api', 'manual')),
            retrieved_at TEXT NOT NULL,
            original_content_hash TEXT NOT NULL,
            perceptual_hash TEXT,
            variant_reference TEXT,
            rights_status TEXT NOT NULL CHECK (rights_status IN ('approved', 'restricted', 'unknown')),
            rights_basis TEXT,
            rights_evidence_ref TEXT,
            observed_brand TEXT,
            observed_product_name TEXT,
            observed_variant TEXT,
            observed_net_content_json TEXT,
            observed_pack_count INTEGER,
            observed_gtin TEXT,
            exact_product_match INTEGER NOT NULL DEFAULT 0,
            exact_variant_match INTEGER,
            quality_status TEXT NOT NULL CHECK (quality_status IN ('usable', 'low_quality', 'invalid')),
            commerce_approved INTEGER NOT NULL DEFAULT 0,
            conflicts_json TEXT NOT NULL DEFAULT '[]',
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_pi_assets_run ON product_intelligence_assets(run_id);
          CREATE INDEX IF NOT EXISTS idx_pi_assets_commerce ON product_intelligence_assets(run_id, commerce_approved);
        `);
      })();
      db.exec("INSERT INTO app_meta (key, value) VALUES ('product_intelligence_assets_schema_version', '1');");
      console.log('[Migrations] Product intelligence asset schema migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Product intelligence asset schema migration failed:', e);
    throw e;
  }

  // ── Product Intelligence Import Migration (PI-8) ─────────────────────────
  // Durable import records: a reviewed Agent Lab run imported to an
  // onboarding item (create or augment), with the field-selection map,
  // excluded/overridden values, and the imported source/evidence/image ids.
  // Idempotent per (run, item); run deletion marks records stale (FK SET
  // NULL) so provenance survives while promotion rejects stale imports.
  try {
    const piImportsVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('product_intelligence_imports_schema_version') as
      | { value: string }
      | undefined;
    if (!piImportsVersion) {
      console.log('[Migrations] Running product intelligence import schema migration...');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS product_intelligence_imports (
            id TEXT PRIMARY KEY,
            run_id TEXT REFERENCES product_intelligence_runs(id) ON DELETE SET NULL,
            onboarding_item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
            result_hash TEXT NOT NULL,
            mode TEXT NOT NULL CHECK (mode IN ('create', 'augment')),
            importing_user TEXT,
            status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'stale')),
            field_selection_json TEXT NOT NULL DEFAULT '[]',
            excluded_values_json TEXT NOT NULL DEFAULT '{}',
            overridden_values_json TEXT NOT NULL DEFAULT '{}',
            imported_source_ids_json TEXT NOT NULL DEFAULT '[]',
            imported_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
            imported_image_ids_json TEXT NOT NULL DEFAULT '[]',
            workflow_id TEXT,
            capability_invocation_ids_json TEXT NOT NULL DEFAULT '[]',
            artifact_hashes_json TEXT NOT NULL DEFAULT '[]',
            verifier_provenance_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            UNIQUE (run_id, onboarding_item_id)
          );
          CREATE INDEX IF NOT EXISTS idx_pi_imports_item ON product_intelligence_imports(onboarding_item_id);
          CREATE INDEX IF NOT EXISTS idx_pi_imports_run ON product_intelligence_imports(run_id);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_pi_imports_workflow_item ON product_intelligence_imports(workflow_id, onboarding_item_id) WHERE workflow_id IS NOT NULL;
        `);
      })();
      db.exec("INSERT INTO app_meta (key, value) VALUES ('product_intelligence_imports_schema_version', '1');");
      console.log('[Migrations] Product intelligence import schema migration complete.');
    } else {
      // v2 SpecialistWorkflowResult provenance columns were added after PI-8.
      for (const statement of [
        'ALTER TABLE product_intelligence_imports ADD COLUMN workflow_id TEXT',
        "ALTER TABLE product_intelligence_imports ADD COLUMN capability_invocation_ids_json TEXT NOT NULL DEFAULT '[]'",
        "ALTER TABLE product_intelligence_imports ADD COLUMN artifact_hashes_json TEXT NOT NULL DEFAULT '[]'",
        "ALTER TABLE product_intelligence_imports ADD COLUMN verifier_provenance_json TEXT NOT NULL DEFAULT '{}'",
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_pi_imports_workflow_item ON product_intelligence_imports(workflow_id, onboarding_item_id) WHERE workflow_id IS NOT NULL',
      ]) {
        try { db.exec(statement); } catch { /* column already exists */ }
      }
    }
  } catch (e) {
    console.error('[Migrations] Product intelligence import schema migration failed:', e);
    throw e;
  }

  // ── Product Intelligence Evaluation Migration (PI-9) ────────────────────
  // Durable evaluation runs: a golden-dataset example compared against a
  // completed Pi run, with the gold labels, prediction, comparison, and
  // outcome preserved for audit. Held-out products are never evaluated by
  // default (the runner defaults to the 'test' split).
  try {
    const piEvalVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('pi_evaluation_schema_version') as
      | { value: string }
      | undefined;
    if (!piEvalVersion) {
      console.log('[Migrations] Running product intelligence evaluation schema migration...');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS pi_evaluation_runs (
            id TEXT PRIMARY KEY,
            dataset_id TEXT NOT NULL REFERENCES benchmark_datasets(id) ON DELETE CASCADE,
            dataset_hash TEXT NOT NULL,
            product_sku TEXT NOT NULL,
            split_group TEXT NOT NULL,
            run_id TEXT REFERENCES product_intelligence_runs(id) ON DELETE SET NULL,
            gold_labels_json TEXT NOT NULL,
            prediction_json TEXT NOT NULL,
            comparison_json TEXT NOT NULL,
            outcome TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_pi_eval_dataset ON pi_evaluation_runs(dataset_id);
          CREATE INDEX IF NOT EXISTS idx_pi_eval_sku ON pi_evaluation_runs(product_sku);
        `);
      })();
      db.exec("INSERT INTO app_meta (key, value) VALUES ('pi_evaluation_schema_version', '1');");
      console.log('[Migrations] Product intelligence evaluation schema migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Product intelligence evaluation schema migration failed:', e);
    throw e;
  }

  // ── Product Intelligence Ops Migration (PI-10) ───────────────────────────
  // Operational tooling: replay lineage (every replay is a new run linked to
  // its origin; originals stay immutable), centralized workspace budgets, and
  // per-category retention policies (metadata / tool calls / sources / raw
  // fetched content / model request+response artifacts / images).
  try {
    const piOpsVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('product_intelligence_ops_schema_version') as
      | { value: string }
      | undefined;
    if (!piOpsVersion) {
      console.log('[Migrations] Running product intelligence ops schema migration...');
      db.transaction(() => {
        // Replay lineage: origin_run_id self-reference (SET NULL so a replayed
        // run survives its origin's deletion); replay_depth guards runaway chains.
        const runCols = db.query("SELECT COUNT(*) AS c FROM pragma_table_info('product_intelligence_runs') WHERE name = 'origin_run_id'").get() as { c: number };
        if (runCols.c === 0) {
          db.exec(`ALTER TABLE product_intelligence_runs ADD COLUMN origin_run_id TEXT REFERENCES product_intelligence_runs(id) ON DELETE SET NULL;`);
        }
        const depthCols = db.query("SELECT COUNT(*) AS c FROM pragma_table_info('product_intelligence_runs') WHERE name = 'replay_depth'").get() as { c: number };
        if (depthCols.c === 0) {
          db.exec(`ALTER TABLE product_intelligence_runs ADD COLUMN replay_depth INTEGER NOT NULL DEFAULT 0;`);
        }
        // Workspace budget policies (NULL fields = unlimited) and per-category
        // retention policies (NULL fields = keep forever). Enforced centrally
        // in src/product-intelligence/budgets.ts / retention.ts, never trusted
        // to the agent prompt.
        db.exec(`
          CREATE TABLE IF NOT EXISTS pi_budget_policies (
            workspace_id TEXT PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
            policy_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS pi_retention_policies (
            workspace_id TEXT PRIMARY KEY REFERENCES workspace(id) ON DELETE CASCADE,
            policy_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
        `);
      })();
      db.exec("INSERT INTO app_meta (key, value) VALUES ('product_intelligence_ops_schema_version', '1');");
      console.log('[Migrations] Product intelligence ops schema migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Product intelligence ops schema migration failed:', e);
    throw e;
  }

  // P0-2 (review remediation): server-authoritative, immutable/versioned PI
  // execution policies. Callers select an approved policy by record id and
  // may only apply strictly-reducing overrides; the policy object itself is
  // never caller-supplied. Each version row is immutable; a policy change
  // creates a new version and deactivates the previous ones (only the newest
  // version of a record may be active).
  try {
    const piApprovedPoliciesVersion = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('product_intelligence_approved_policies_schema_version') as
      | { value: string }
      | undefined;
    if (!piApprovedPoliciesVersion) {
      console.log('[Migrations] Running product intelligence approved policies migration...');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS pi_approved_policies (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            version INTEGER NOT NULL,
            policy_json TEXT NOT NULL,
            policy_config_id TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            UNIQUE(workspace_id, name, version)
          );
          CREATE INDEX IF NOT EXISTS idx_pi_approved_policies_ws_active ON pi_approved_policies(workspace_id, active);
        `);
      })();
      db.exec("INSERT INTO app_meta (key, value) VALUES ('product_intelligence_approved_policies_schema_version', '1');");
      console.log('[Migrations] Product intelligence approved policies migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Product intelligence approved policies migration failed:', e);
    throw e;
  }

  // Review remediation (P1-2/P0-6): durable human review decisions for
  // Agent Lab imports, server-authoritative reuse grants for image rights,
  // and the extended extraction_method CHECK on product_intelligence_assets.
  // Review decisions are append-only: every approve/reject is a new row with
  // a result_hash binding the decision to the exact stored result, chained
  // via supersedes_decision_id. Reuse grants are workspace-scoped
  // (source tier + domain pattern) and resolve independently of source
  // identity — a canonical vendor domain proves ORIGIN, never reuse rights.
  try {
    const reviewRemediationVersion = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('pi_review_remediation_schema_version') as
      | { value: string }
      | undefined;
    if (!reviewRemediationVersion) {
      console.log('[Migrations] Running review remediation schema migration...');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS pi_review_decisions (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
            decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
            result_hash TEXT NOT NULL,
            supersedes_decision_id TEXT REFERENCES pi_review_decisions(id),
            reviewer TEXT NOT NULL,
            note TEXT,
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_pi_review_decisions_run ON pi_review_decisions(run_id);
          CREATE TABLE IF NOT EXISTS pi_reuse_policies (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
            source_tier TEXT NOT NULL,
            domain_pattern TEXT NOT NULL,
            allowed INTEGER NOT NULL DEFAULT 1,
            terms TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(workspace_id, source_tier, domain_pattern)
          );
          -- SQLite cannot ALTER a CHECK constraint: rebuild the assets table
          -- with the extended extraction_method enum ('image_ocr', 'decoder'
          -- were added to the zod schema in P0-6). No table references
          -- product_intelligence_assets (verified), so the drop/rename is safe.
          CREATE TABLE IF NOT EXISTS product_intelligence_assets_new (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
            source_id TEXT REFERENCES product_intelligence_sources(id) ON DELETE SET NULL,
            source_url TEXT NOT NULL,
            source_page_url TEXT,
            source_type TEXT NOT NULL,
            source_path TEXT,
            source_artifact_id TEXT,
            extraction_method TEXT NOT NULL CHECK (extraction_method IN ('json_ld', 'platform_api', 'network_response', 'profile_selector', 'media_api', 'manual', 'image_ocr', 'decoder')),
            retrieved_at TEXT NOT NULL,
            original_content_hash TEXT NOT NULL,
            perceptual_hash TEXT,
            variant_reference TEXT,
            rights_status TEXT NOT NULL CHECK (rights_status IN ('approved', 'restricted', 'unknown')),
            rights_basis TEXT,
            rights_evidence_ref TEXT,
            observed_brand TEXT,
            observed_product_name TEXT,
            observed_variant TEXT,
            observed_net_content_json TEXT,
            observed_pack_count INTEGER,
            observed_gtin TEXT,
            exact_product_match INTEGER NOT NULL DEFAULT 0,
            exact_variant_match INTEGER,
            quality_status TEXT NOT NULL CHECK (quality_status IN ('usable', 'low_quality', 'invalid')),
            commerce_approved INTEGER NOT NULL DEFAULT 0,
            conflicts_json TEXT NOT NULL DEFAULT '[]',
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          INSERT INTO product_intelligence_assets_new
            (id, run_id, source_id, source_url, source_page_url, source_type, source_path, source_artifact_id,
             extraction_method, retrieved_at, original_content_hash, perceptual_hash, variant_reference,
             rights_status, rights_basis, rights_evidence_ref, observed_brand, observed_product_name,
             observed_variant, observed_net_content_json, observed_pack_count, observed_gtin,
             exact_product_match, exact_variant_match, quality_status, commerce_approved, conflicts_json,
             payload_json, created_at)
          SELECT id, run_id, source_id, source_url, source_page_url, source_type, source_path, source_artifact_id,
             extraction_method, retrieved_at, original_content_hash, perceptual_hash, variant_reference,
             rights_status, rights_basis, rights_evidence_ref, observed_brand, observed_product_name,
             observed_variant, observed_net_content_json, observed_pack_count, observed_gtin,
             exact_product_match, exact_variant_match, quality_status, commerce_approved, conflicts_json,
             payload_json, created_at
          FROM product_intelligence_assets;
          DROP TABLE product_intelligence_assets;
          ALTER TABLE product_intelligence_assets_new RENAME TO product_intelligence_assets;
          CREATE INDEX IF NOT EXISTS idx_pi_assets_run ON product_intelligence_assets(run_id);
          CREATE INDEX IF NOT EXISTS idx_pi_assets_commerce ON product_intelligence_assets(run_id, commerce_approved);
        `);
      })();
      db.exec("INSERT INTO app_meta (key, value) VALUES ('pi_review_remediation_schema_version', '1');");
      console.log('[Migrations] Review remediation schema migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Review remediation schema migration failed:', e);
    throw e;
  }

  // Policy lineage (review finding 7): real reruns reauthorize the BASE
  // approved-policy record, then re-apply the stored reducing overrides.
  // Without this, a run created with a reducing override has a resolved
  // configId with no matching pi_approved_policies row, so the rerun gate
  // would refuse a perfectly valid run. base_policy_id/version reference the
  // immutable approved record; policy_overrides_json holds the exact
  // override snapshot the run was created with (re-validated as still
  // reducing on every rerun).
  try {
    const policyLineageVersion = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('product_intelligence_policy_lineage_schema_version') as
      | { value: string }
      | undefined;
    if (!policyLineageVersion) {
      console.log('[Migrations] Running product intelligence policy lineage migration...');
      db.transaction(() => {
        const baseIdCols = db.query("SELECT COUNT(*) AS c FROM pragma_table_info('product_intelligence_runs') WHERE name = 'base_policy_id'").get() as { c: number };
        if (baseIdCols.c === 0) {
          db.exec('ALTER TABLE product_intelligence_runs ADD COLUMN base_policy_id TEXT;');
        }
        const baseVersionCols = db.query("SELECT COUNT(*) AS c FROM pragma_table_info('product_intelligence_runs') WHERE name = 'base_policy_version'").get() as { c: number };
        if (baseVersionCols.c === 0) {
          db.exec('ALTER TABLE product_intelligence_runs ADD COLUMN base_policy_version INTEGER;');
        }
        const overridesCols = db.query("SELECT COUNT(*) AS c FROM pragma_table_info('product_intelligence_runs') WHERE name = 'policy_overrides_json'").get() as { c: number };
        if (overridesCols.c === 0) {
          db.exec('ALTER TABLE product_intelligence_runs ADD COLUMN policy_overrides_json TEXT;');
        }
      })();
      db.exec("INSERT INTO app_meta (key, value) VALUES ('product_intelligence_policy_lineage_schema_version', '1');");
      console.log('[Migrations] Product intelligence policy lineage migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Product intelligence policy lineage migration failed:', e);
    throw e;
  }

  // Round-8 (review P1): capture effective research-tool versions + schema
  // hashes on runs for replay/provenance. Tool NAMES are already persisted
  // via tool_calls rows; versions and schema hashes need the run-level field.
  // tools_json = JSON array of { name, version, schemaHash } for every
  // effective research/terminal tool in the session, captured at session
  // creation (the executor writes it once the session exists — the tools are
  // not knowable at createPiRun time).
  try {
    const toolsVersion = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('pi_tools_capture_schema_version') as
      | { value: string }
      | undefined;
    if (!toolsVersion) {
      console.log('[Migrations] Running pi tools capture migration...');
      db.transaction(() => {
        const toolsCols = db.query("SELECT COUNT(*) AS c FROM pragma_table_info('product_intelligence_runs') WHERE name = 'tools_json'").get() as { c: number };
        if (toolsCols.c === 0) {
          db.exec('ALTER TABLE product_intelligence_runs ADD COLUMN tools_json TEXT;');
        }
      })();
      db.exec("INSERT INTO app_meta (key, value) VALUES ('pi_tools_capture_schema_version', '1');");
      console.log('[Migrations] Pi tools capture migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Pi tools capture migration failed:', e);
    throw e;
  }

  // Round-4 (review P0): a 'server-verified' image asset must be bound to the
  // run's immutable product identity. verified_against_hash is the SHA-256 of
  // the canonical identity snapshot (runId + gtin + name, server-derived from
  // the run input at verification time) — the terminal validator recomputes it
  // from the CURRENT run's input and refuses assets that were verified against
  // anything else. declared_source_type is the durable source-kind derived from
  // the source row, never the agent's declared string.
  try {
    const verifiedAgainstVersion = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('pi_assets_verified_against_schema_version') as
      | { value: string }
      | undefined;
    if (!verifiedAgainstVersion) {
      console.log('[Migrations] Running pi assets verified-against schema migration...');
      db.transaction(() => {
        const jsonCols = db.query("SELECT COUNT(*) AS c FROM pragma_table_info('product_intelligence_assets') WHERE name = 'verified_against_json'").get() as { c: number };
        if (jsonCols.c === 0) {
          db.exec('ALTER TABLE product_intelligence_assets ADD COLUMN verified_against_json TEXT;');
        }
        const hashCols = db.query("SELECT COUNT(*) AS c FROM pragma_table_info('product_intelligence_assets') WHERE name = 'verified_against_hash'").get() as { c: number };
        if (hashCols.c === 0) {
          db.exec('ALTER TABLE product_intelligence_assets ADD COLUMN verified_against_hash TEXT;');
        }
        const sourceTypeCols = db.query("SELECT COUNT(*) AS c FROM pragma_table_info('product_intelligence_assets') WHERE name = 'declared_source_type'").get() as { c: number };
        if (sourceTypeCols.c === 0) {
          db.exec('ALTER TABLE product_intelligence_assets ADD COLUMN declared_source_type TEXT;');
        }
      })();
      db.exec("INSERT INTO app_meta (key, value) VALUES ('pi_assets_verified_against_schema_version', '1');");
      console.log('[Migrations] Pi assets verified-against schema migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Pi assets verified-against schema migration failed:', e);
    throw e;
  }

  // Round-7 (review P0): server-CREATED image-candidate provenance. The
  // candidate->discovering-page relationship is established by the server when
  // discover_image_candidates runs; verify_image_candidate cites the durable
  // record (candidateId) and the source tier / rights grant resolve from its
  // discovering source — never from an agent-supplied sourcePageUrl or
  // agent-selected evidence rows.
  try {
    const candidateVersion = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('pi_image_candidates_schema_version') as { value: string } | undefined;
    if (!candidateVersion) {
      console.log('[Migrations] Running pi image candidates schema migration...');
      db.exec(`CREATE TABLE IF NOT EXISTS pi_image_candidates (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
        image_url TEXT NOT NULL,
        discovering_source_id TEXT REFERENCES product_intelligence_sources(id) ON DELETE SET NULL,
        source_artifact_id TEXT,
        source_path TEXT,
        extraction_method TEXT,
        variant_reference TEXT,
        created_at TEXT NOT NULL
      );`);
      db.exec("INSERT INTO app_meta (key, value) VALUES ('pi_image_candidates_schema_version', '1');");
      console.log('[Migrations] Pi image candidates schema migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Pi image candidates schema migration failed:', e);
    throw e;
  }

  // Round-9 (review P1): media-set/entity identity on image candidates —
  // supporting images must be durably linked to the SAME product entity
  // (SKU/productId/@id/variation id), never merely the same discovering page.
  try {
    const entityVersion = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('pi_image_candidates_entity_schema_version') as { value: string } | undefined;
    if (!entityVersion) {
      console.log('[Migrations] Running pi image candidates entity-id migration...');
      db.exec('ALTER TABLE pi_image_candidates ADD COLUMN entity_id TEXT NULL;');
      db.exec("INSERT INTO app_meta (key, value) VALUES ('pi_image_candidates_entity_schema_version', '1');");
      console.log('[Migrations] Pi image candidates entity-id migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Pi image candidates entity-id migration failed:', e);
    throw e;
  }

  // Round-9 (review P0): first-class durable source authority. Rights tiers
  // never derive from evidence kinds; check_source_priority (or future
  // trusted CMS records) establish authority here with a brand-matched
  // manufacturer/supplier relationship.
  try {
    const authorityVersion = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('pi_source_authorities_schema_version') as { value: string } | undefined;
    if (!authorityVersion) {
      console.log('[Migrations] Running pi source authorities schema migration...');
      db.exec(`CREATE TABLE IF NOT EXISTS pi_source_authorities (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES product_intelligence_sources(id) ON DELETE CASCADE,
        authority_type TEXT NOT NULL,
        authority_ref TEXT,
        brand_name TEXT,
        established_by TEXT NOT NULL,
        established_at TEXT NOT NULL,
        UNIQUE(source_id, authority_type)
      );`);
      db.exec("INSERT INTO app_meta (key, value) VALUES ('pi_source_authorities_schema_version', '1');");
      console.log('[Migrations] Pi source authorities schema migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Pi source authorities schema migration failed:', e);
    throw e;
  }

  // Round-9 (review P1-1/P1-5): artifact-driven image discovery. The server
  // retains bounded page artifacts (content + hash); discover_image_candidates
  // loads them by artifactId — the agent never supplies artifact bytes — and
  // each candidate row records the attestation (artifact id + attested hash)
  // that made the candidate->page relationship trustworthy.
  try {
    const artifactVersion = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('pi_artifact_driven_discovery_schema_version') as { value: string } | undefined;
    if (!artifactVersion) {
      console.log('[Migrations] Running pi artifact-driven discovery schema migration...');
      db.exec(`CREATE TABLE IF NOT EXISTS pi_page_artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        content TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );`);
      db.exec('ALTER TABLE pi_image_candidates ADD COLUMN attestation_artifact_id TEXT NULL;');
      db.exec('ALTER TABLE pi_image_candidates ADD COLUMN attested_content_hash TEXT NULL;');
      db.exec("INSERT INTO app_meta (key, value) VALUES ('pi_artifact_driven_discovery_schema_version', '1');");
      console.log('[Migrations] Pi artifact-driven discovery schema migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Pi artifact-driven discovery schema migration failed:', e);
    throw e;
  }

  // Round-10 (review P0/P1): run-scoped artifact authority + durable
  // asset->candidate linkage + typed page artifacts.
  // - pi_page_artifacts gains artifact_type ('page_html' | 'browser_network_capture').
  // - Attestation is referentially enforced with a SAME-RUN trigger (a plain
  //   FK cannot express "artifact must belong to this candidate's run").
  // - product_intelligence_assets gains candidate_id (exact FK to the
  //   pi_image_candidates row the asset was verified from), same-run enforced.
  // ADR-0030 Phase 4: the PI-only tables are dropped on decommissioned
  // databases. Each probe below must therefore also require its target table
  // to exist before attempting DDL against it.
  const piTableExists = (name: string): boolean =>
    !!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  const artifactColumns = db.query("SELECT name FROM pragma_table_info('pi_page_artifacts') WHERE name = 'artifact_type'").get();
  if (!artifactColumns && piTableExists('pi_page_artifacts')) {
    db.exec("ALTER TABLE pi_page_artifacts ADD COLUMN artifact_type TEXT NOT NULL DEFAULT 'page_html';");
  }
  const candidateRunTrigger = db
    .query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_pi_candidate_attestation_same_run'")
    .get();
  if (!candidateRunTrigger && piTableExists('pi_image_candidates') && piTableExists('pi_page_artifacts')) {
    db.exec(`
      CREATE TRIGGER trg_pi_candidate_attestation_same_run
      BEFORE INSERT ON pi_image_candidates
      WHEN NEW.attestation_artifact_id IS NOT NULL
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM pi_page_artifacts WHERE id = NEW.attestation_artifact_id)
            THEN RAISE(ABORT, 'attestation_artifact_id references a nonexistent pi_page_artifacts row')
          WHEN (SELECT run_id FROM pi_page_artifacts WHERE id = NEW.attestation_artifact_id) <> NEW.run_id
            THEN RAISE(ABORT, 'attestation_artifact_id belongs to a different run')
        END;
      END;`);
  }
  const assetCandidateColumn = db
    .query("SELECT name FROM pragma_table_info('product_intelligence_assets') WHERE name = 'candidate_id'")
    .get();
  if (!assetCandidateColumn) {
    db.exec('ALTER TABLE product_intelligence_assets ADD COLUMN candidate_id TEXT NULL;');
  }
  const assetCandidateTrigger = db
    .query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_pi_asset_candidate_same_run'")
    .get();
  if (!assetCandidateTrigger && piTableExists('product_intelligence_assets') && piTableExists('pi_image_candidates')) {
    db.exec(`
      CREATE TRIGGER trg_pi_asset_candidate_same_run
      BEFORE INSERT ON product_intelligence_assets
      WHEN NEW.candidate_id IS NOT NULL
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM pi_image_candidates WHERE id = NEW.candidate_id)
            THEN RAISE(ABORT, 'candidate_id references a nonexistent pi_image_candidates row')
          WHEN (SELECT run_id FROM pi_image_candidates WHERE id = NEW.candidate_id) <> NEW.run_id
            THEN RAISE(ABORT, 'candidate_id belongs to a different run')
        END;
      END;`);
  }
  db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('pi_round10_authority_schema_version', '1');");
  console.log('[Migrations] Pi round-10 authority schema migration complete.');

  // Round-11 (review P0/P1s): workspace authority + evidence-provenanced
  // brand authority.
  // - trg_pi_asset_candidate_same_run is strengthened: the candidate's
  //   image_url must equal the asset's source_url (the invariant the live
  //   verifier already enforces becomes a storage invariant too).
  // - pi_source_authorities retains the evidence that resolved the brand
  //   (verified asset id + content hash + evidence kind) so an authority
  //   record is a durable statement "Brand A was observed from evidence E
  //   on asset bytes H whose GTIN X was independently exact".
  const round11 = db
    .query("SELECT value FROM app_meta WHERE key = 'pi_round11_authority_schema_version'")
    .get() as { value: string } | undefined;
  if (!round11) {
    db.exec('DROP TRIGGER IF EXISTS trg_pi_asset_candidate_same_run;');
    db.exec(`
      CREATE TRIGGER trg_pi_asset_candidate_same_run
      BEFORE INSERT ON product_intelligence_assets
      WHEN NEW.candidate_id IS NOT NULL
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM pi_image_candidates WHERE id = NEW.candidate_id)
            THEN RAISE(ABORT, 'candidate_id references a nonexistent pi_image_candidates row')
          WHEN (SELECT run_id FROM pi_image_candidates WHERE id = NEW.candidate_id) <> NEW.run_id
            THEN RAISE(ABORT, 'candidate_id belongs to a different run')
          WHEN (SELECT image_url FROM pi_image_candidates WHERE id = NEW.candidate_id) <> NEW.source_url
            THEN RAISE(ABORT, 'candidate image_url must equal the asset source_url')
        END;
      END;`);
    const authCols = db.query("SELECT name FROM pragma_table_info('pi_source_authorities')").all() as Array<{ name: string }>;
    if (!authCols.some((c) => c.name === 'brand_evidence_id')) {
      db.exec('ALTER TABLE pi_source_authorities ADD COLUMN brand_evidence_id TEXT NULL;');
      db.exec('ALTER TABLE pi_source_authorities ADD COLUMN brand_evidence_hash TEXT NULL;');
      db.exec('ALTER TABLE pi_source_authorities ADD COLUMN brand_evidence_kind TEXT NULL;');
    }
    db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('pi_round11_authority_schema_version', '1');");
    console.log('[Migrations] Pi round-11 authority schema migration complete.');
  }

  // Round-12 (review P0-3): assets retain the QUALIFYING brand evidence
  // binding — the exact evidence row + hash that established the observed
  // brand (never reconstructed from observedBrand + image hash later).
  const assetBrandEvidence = db
    .query("SELECT name FROM pragma_table_info('product_intelligence_assets') WHERE name = 'brand_evidence_id'")
    .get();
  if (!assetBrandEvidence) {
    db.exec('ALTER TABLE product_intelligence_assets ADD COLUMN brand_evidence_id TEXT NULL;');
    db.exec('ALTER TABLE product_intelligence_assets ADD COLUMN brand_evidence_hash TEXT NULL;');
    db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('pi_round12_brand_evidence_schema_version', '1');");
    console.log('[Migrations] Pi round-12 brand-evidence schema migration complete.');
  }

  // Onboarding evidence attempts table (distributor evidence lookups).
  // Referenced by the committed onboarding-evidence-repo and the item
  // detail / resolve-sourcing routes, but previously only created by
  // uncommitted multi-distributor V2 work; without it every item detail
  // fetch 500s. The pending V2 work extends this table defensively via
  // PRAGMA-guarded ALTERs, so a pre-existing table is compatible.
  const evidenceAttemptsTable = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'onboarding_evidence_attempts'")
    .get();
  if (!evidenceAttemptsTable) {
    db.exec(`
      CREATE TABLE onboarding_evidence_attempts (
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
      );
      CREATE INDEX IF NOT EXISTS idx_onboarding_evidence_attempts_item ON onboarding_evidence_attempts(item_id);
      CREATE INDEX IF NOT EXISTS idx_onboarding_evidence_attempts_provider ON onboarding_evidence_attempts(provider_id);
      CREATE INDEX IF NOT EXISTS idx_onboarding_evidence_attempts_upc ON onboarding_evidence_attempts(lookup_upc);
    `);
    db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('onboarding_evidence_attempts_schema_version', '1');");
    console.log('[Migrations] Onboarding evidence attempts table migration complete.');
  }

  // ── Multi-Distributor Sourcing V2 schema (ADR 0014) ──────────────────────
  //
  // Gated by `distributor_v2_schema_version`. Runs AFTER the 13-column
  // evidence-attempts table exists: creates the new tables idempotently from
  // distributor-v2-migration.sql, extends pre-existing tables with
  // PRAGMA-guarded ALTERs (five recovered columns + `sourcing_generation_id`),
  // backfills `observed_at`, binds historical attempts to deterministic
  // legacy connections (never an arbitrary "first connection" fallback),
  // builds the idempotency indexes, and ONLY THEN writes the marker. A
  // failure mid-block aborts BEFORE the marker, so the next startup re-runs
  // the whole block (idempotent).
  const distributorV2Version = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get('distributor_v2_schema_version') as { value: string } | undefined;
  if (!distributorV2Version) {
    // The whole block runs in ONE transaction: a failure rolls back every
    // DDL/data change and leaves the marker absent, so the next startup
    // re-runs the entire block cleanly.
    db.transaction(() => {
      const v2Sql = fs.readFileSync(DISTRIBUTOR_V2_MIGRATION_PATH, 'utf-8');
      db.exec(v2Sql);

    const v2Now = new Date().toISOString();

    // PRAGMA-guarded ALTERs on the pre-existing 13-column evidence table.
    const evidenceCols = db.query('PRAGMA table_info(onboarding_evidence_attempts)').all() as Array<{ name: string }>;
    const hasEvidenceColumn = (name: string) => evidenceCols.some((c) => c.name === name);
    if (!hasEvidenceColumn('distributor_connection_id')) {
      db.exec('ALTER TABLE onboarding_evidence_attempts ADD COLUMN distributor_connection_id TEXT REFERENCES distributor_connections(id) ON DELETE SET NULL;');
    }
    if (!hasEvidenceColumn('catalog_snapshot_id')) {
      db.exec('ALTER TABLE onboarding_evidence_attempts ADD COLUMN catalog_snapshot_id TEXT REFERENCES distributor_catalog_snapshots(id) ON DELETE SET NULL;');
    }
    if (!hasEvidenceColumn('catalog_version')) {
      db.exec('ALTER TABLE onboarding_evidence_attempts ADD COLUMN catalog_version TEXT;');
    }
    if (!hasEvidenceColumn('observed_at')) {
      db.exec('ALTER TABLE onboarding_evidence_attempts ADD COLUMN observed_at TEXT;');
    }
    if (!hasEvidenceColumn('expires_at')) {
      db.exec('ALTER TABLE onboarding_evidence_attempts ADD COLUMN expires_at TEXT;');
    }
    if (!hasEvidenceColumn('sourcing_generation_id')) {
      db.exec('ALTER TABLE onboarding_evidence_attempts ADD COLUMN sourcing_generation_id TEXT REFERENCES sourcing_generations(id) ON DELETE SET NULL;');
    }
    // Backfill observed_at for pre-existing rows (ADR 0014 retention).
    db.exec('UPDATE onboarding_evidence_attempts SET observed_at = created_at WHERE observed_at IS NULL;');

    // Generation column on conflicts + acceptances (nullable; legacy rows stay NULL).
    const conflictCols = db.query('PRAGMA table_info(onboarding_evidence_conflicts)').all() as Array<{ name: string }>;
    if (!conflictCols.some((c) => c.name === 'sourcing_generation_id')) {
      db.exec('ALTER TABLE onboarding_evidence_conflicts ADD COLUMN sourcing_generation_id TEXT REFERENCES sourcing_generations(id) ON DELETE SET NULL;');
    }
    const acceptanceCols = db.query('PRAGMA table_info(onboarding_item_evidence_acceptances)').all() as Array<{ name: string }>;
    if (!acceptanceCols.some((c) => c.name === 'sourcing_generation_id')) {
      db.exec('ALTER TABLE onboarding_item_evidence_acceptances ADD COLUMN sourcing_generation_id TEXT REFERENCES sourcing_generations(id) ON DELETE SET NULL;');
    }

    // Idempotency indexes (ADR 0014: one attempt per item+CONNECTION+
    // generation — two connections may share a provider; one OPEN conflict
    // per item+field+generation).
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_attempts_generation_conn
      ON onboarding_evidence_attempts(item_id, distributor_connection_id, sourcing_generation_id)
      WHERE distributor_connection_id IS NOT NULL AND sourcing_generation_id IS NOT NULL;`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_conflicts_open_unique
      ON onboarding_evidence_conflicts(item_id, field, sourcing_generation_id)
      WHERE status = 'open';`);

    // Deterministic legacy backfill: one distributor + connection per
    // (workspace, provider) pair, bound by the attempt→item→batch→workspace
    // chain (always unambiguous). Ambiguous rows stay NULL; there is NO
    // "first connection in the database" fallback.
    const legacyRows = db
      .query(`SELECT w.id AS workspace_id, a.provider_id
              FROM onboarding_evidence_attempts a
              JOIN onboarding_items i ON i.id = a.item_id
              JOIN onboarding_batches b ON b.id = i.batch_id
              JOIN workspace w ON w.id = b.workspace_id
              GROUP BY w.id, a.provider_id`)
      .all() as Array<{ workspace_id: string; provider_id: string }>;
    for (const legacy of legacyRows) {
      const distributorId = `legacy_${legacy.provider_id}`;
      db.query(
        "INSERT OR IGNORE INTO distributors (id, name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
      ).run(distributorId, legacy.provider_id, v2Now, v2Now);
      const connectionId = `legacy_${sha256Hex(`${legacy.workspace_id}:${legacy.provider_id}`).slice(0, 12)}`;
      db.query(
        `INSERT OR IGNORE INTO distributor_connections
          (id, workspace_id, distributor_id, connector_type, secret_ref, configuration_json, authority_policy_json, enabled, created_at, updated_at)
         VALUES (?, ?, ?, 'legacy_adapter', NULL, '{}', '{}', 1, ?, ?)`,
      ).run(connectionId, legacy.workspace_id, distributorId, v2Now, v2Now);
      db.query(
        `UPDATE onboarding_evidence_attempts SET distributor_connection_id = ?
         WHERE provider_id = ? AND item_id IN (
           SELECT i.id FROM onboarding_items i
           JOIN onboarding_batches b ON b.id = i.batch_id
           WHERE b.workspace_id = ?
         )`,
      ).run(connectionId, legacy.provider_id, legacy.workspace_id);
    }

      const v2FkViolations = db.query('PRAGMA foreign_key_check').all() as Array<{ table: string }>;
      if (v2FkViolations.length > 0) {
        throw new Error(`[Migrations] distributor_v2 foreign_key_check failed: ${JSON.stringify(v2FkViolations.slice(0, 5))}`);
      }
      db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('distributor_v2_schema_version', '1');");
    })();
    console.log('[Migrations] Distributor V2 schema migration complete.');
  }

  // Brand Sourcing Strategy approval + Preparation gaps (spec #120).
  // Additive-only new tables; idempotent via CREATE TABLE IF NOT EXISTS.
  const brandStrategyVersion = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get('brand_strategy_schema_version') as { value: string } | undefined;
  if (!brandStrategyVersion) {
    db.transaction(() => {
      const strategySql = fs.readFileSync(BRAND_STRATEGY_MIGRATION_PATH, 'utf-8');
      db.exec(strategySql);
      db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('brand_strategy_schema_version', '1');");
    })();
    console.log('[Migrations] Brand sourcing strategy schema migration complete.');
  }

  // Brand strategy builder slice B2: durable per-generation strategy binding.
  // Additive-only append-only table; idempotent via CREATE TABLE IF NOT EXISTS.
  // No backfill of historical generations, no alteration of existing tables.
  const brandStrategyBuilderVersion = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get('brand_strategy_builder_schema_version') as { value: string } | undefined;
  if (!brandStrategyBuilderVersion) {
    db.transaction(() => {
      const builderSql = fs.readFileSync(BRAND_STRATEGY_BUILDER_MIGRATION_PATH, 'utf-8');
      db.exec(builderSql);
      db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('brand_strategy_builder_schema_version', '1');");
    })();
    console.log('[Migrations] Brand strategy builder schema migration complete.');
  }

  // Ticket #122: durable completed strategy-collection envelope (A-lite).
  // Additive-only new table; idempotent via CREATE TABLE IF NOT EXISTS.
  // No backfill of historical generations, no alteration of existing tables.
  const strategyCollectionResultVersion = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get('strategy_collection_result_schema_version') as { value: string } | undefined;
  if (!strategyCollectionResultVersion) {
    db.transaction(() => {
      const collectionSql = fs.readFileSync(STRATEGY_COLLECTION_RESULT_MIGRATION_PATH, 'utf-8');
      db.exec(collectionSql);
      db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('strategy_collection_result_schema_version', '1');");
    })();
    console.log('[Migrations] Strategy collection result schema migration complete.');
  }

  // ── Evidence connection index repair (ADR 0014) ────────────────────────────
  //
  // Independent marker (`distributor_evidence_index_schema_version`) — NOT
  // coupled to `distributor_v2_schema_version`. Databases migrated by an
  // older v2 block wrote the v2 marker BEFORE the connection-scoped
  // idempotency index existed; they carry the superseded provider-scoped
  // unique index (`idx_evidence_attempts_generation_provider`) and NO
  // `idx_evidence_attempts_generation_conn`. On such databases the
  // repository's `ON CONFLICT(item_id, distributor_connection_id,
  // sourcing_generation_id)` fails at prepare time ("ON CONFLICT clause does
  // not match any PRIMARY KEY or UNIQUE constraint"). This block creates the
  // connection-scoped index and DROPS the provider-scoped one (its
  // uniqueness contract is superseded: two connections may share a
  // provider). On fresh databases both statements are no-ops.
  const evidenceIndexVersion = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get('distributor_evidence_index_schema_version') as { value: string } | undefined;
  if (!evidenceIndexVersion) {
    db.transaction(() => {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_attempts_generation_conn
        ON onboarding_evidence_attempts(item_id, distributor_connection_id, sourcing_generation_id)
        WHERE distributor_connection_id IS NOT NULL AND sourcing_generation_id IS NOT NULL;`);
      db.exec('DROP INDEX IF EXISTS idx_evidence_attempts_generation_provider');
      db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('distributor_evidence_index_schema_version', '1');");
    })();
    console.log('[Migrations] Distributor evidence connection index migration complete.');
  } else {
    // Drift guard: the connection-scoped index must exist and the superseded
    // provider-scoped index must be gone. A marker with the wrong indexes is
    // fail-closed (throw at startup), never silently re-paired.
    const connIndex = db
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_evidence_attempts_generation_conn'")
      .get();
    const providerIndex = db
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_evidence_attempts_generation_provider'")
      .get();
    if (!connIndex || providerIndex) {
      throw new Error(
        `[Migrations] distributor_evidence_index drift: connection index ${connIndex ? 'present' : 'MISSING'}, superseded provider index ${providerIndex ? 'still PRESENT' : 'absent'}`,
      );
    }
  }

  // ── Default-On Sourcing schema (Amendment A) ───────────────────────────────
  //
  // Gated by `default_on_sourcing_schema_version` (written LAST inside one
  // transaction). Runs AFTER the distributor-v2 block. Adds:
  // - onboarding_items.source_type (CHECK official_page|distributor_record)
  //   + sourcing_entry_policy_version (default 0 — existing rows stay 0;
  //   only post-amendment import call sites may write 1);
  // - onboarding_extractions: nullable source_url + source_type +
  //   sourcing_generation_id + accepted_evidence_attempt_ids_json +
  //   evidence_hash (distributor-record provenance is representable WITHOUT a
  //   URL; official extraction still fails closed without one);
  // - onboarding_evidence_attempts.duration_ms (measured p95/source-error
  //   gates);
  // - classification_evidence.source CHECK gains 'distributor_record'.
  //
  // `onboarding_extractions` is REBUILT when PRAGMA reports a non-null URL or
  // missing provenance columns (SQLite cannot relax NOT NULL or add a CHECK
  // in place); `classification_evidence` is rebuilt when its stored CHECK
  // lacks distributor_record. Both swaps preserve every row id/count inside
  // ONE transaction with `PRAGMA defer_foreign_keys = ON` (delays FK
  // enforcement to COMMIT so the drop/rename swap is legal; any violation
  // fails the commit, rolls back ALL DDL/data, and leaves the marker absent).
  const defaultOnSourcingVersion = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get('default_on_sourcing_schema_version') as { value: string } | undefined;
  if (!defaultOnSourcingVersion) {
    db.transaction(() => {
      db.exec('PRAGMA defer_foreign_keys = ON');

      // 1) onboarding_items: source_type + entry-policy version.
      const itemsCols = db.query('PRAGMA table_info(onboarding_items)').all() as Array<{ name: string }>;
      if (!itemsCols.some((c) => c.name === 'source_type')) {
        db.exec("ALTER TABLE onboarding_items ADD COLUMN source_type TEXT NOT NULL DEFAULT 'official_page' CHECK (source_type IN ('official_page','distributor_record'));");
      }
      if (!itemsCols.some((c) => c.name === 'sourcing_entry_policy_version')) {
        db.exec('ALTER TABLE onboarding_items ADD COLUMN sourcing_entry_policy_version INTEGER NOT NULL DEFAULT 0;');
      }

      // 2) Evidence attempts: duration_ms for measured p95/source-error gates.
      //    (variant_axis_declarations is added by its OWN marker-gated block
      //    below so pre-marked installations still converge.)
      const attemptCols = db.query('PRAGMA table_info(onboarding_evidence_attempts)').all() as Array<{ name: string }>;
      if (!attemptCols.some((c) => c.name === 'duration_ms')) {
        db.exec('ALTER TABLE onboarding_evidence_attempts ADD COLUMN duration_ms INTEGER;');
      }

      // 3) Rebuild onboarding_extractions when the stored shape is pre-Amendment-A
      //    (non-null source_url or missing distributor provenance columns).
      const extCols = db.query('PRAGMA table_info(onboarding_extractions)').all() as Array<{ name: string; notnull: number }>;
      const extNames = new Set(extCols.map((c) => c.name));
      const urlCol = extCols.find((c) => c.name === 'source_url');
      const urlNotNull = urlCol ? urlCol.notnull === 1 : false;
      const missingExtProv =
        !extNames.has('source_type') ||
        !extNames.has('sourcing_generation_id') ||
        !extNames.has('accepted_evidence_attempt_ids_json') ||
        !extNames.has('evidence_hash');
      if (urlNotNull || missingExtProv) {
        const before = db.query('SELECT COUNT(*) AS cnt FROM onboarding_extractions').get() as { cnt: number };
        const beforeIds = (db.query('SELECT id FROM onboarding_extractions ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
        db.exec(`
          CREATE TABLE onboarding_extractions_new (
            id TEXT PRIMARY KEY,
            item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
            source_url TEXT,
            extraction_data_json TEXT NOT NULL,
            extraction_method TEXT NOT NULL,
            confidence REAL NOT NULL DEFAULT 0.0,
            images_json TEXT,
            raw_structured_data_json TEXT,
            source_type TEXT NOT NULL DEFAULT 'official_page' CHECK (source_type IN ('official_page','distributor_record')),
            sourcing_generation_id TEXT,
            accepted_evidence_attempt_ids_json TEXT,
            evidence_hash TEXT,
            manual_attestation_id TEXT,
            created_at TEXT NOT NULL
          );
        `);
        db.exec(`
          INSERT INTO onboarding_extractions_new
            (id, item_id, source_url, extraction_data_json, extraction_method, confidence, images_json, raw_structured_data_json, created_at)
          SELECT id, item_id, source_url, extraction_data_json, extraction_method, confidence, images_json, raw_structured_data_json, created_at
          FROM onboarding_extractions;
        `);
        // Preserve manual-evidence linkage when rebuilding a table that
        // already carries it (fresh-vs-upgraded column ORDER must converge;
        // pre-Amendment shapes never hold manual rows, so this is a no-op
        // there and a no-data-loss guard everywhere else).
        if (extNames.has('manual_attestation_id')) {
          db.exec(`
            UPDATE onboarding_extractions_new SET manual_attestation_id =
              (SELECT o.manual_attestation_id FROM onboarding_extractions o
               WHERE o.id = onboarding_extractions_new.id);
          `);
        }
        db.exec('DROP TABLE onboarding_extractions;');
        db.exec('ALTER TABLE onboarding_extractions_new RENAME TO onboarding_extractions;');
        db.exec('CREATE INDEX IF NOT EXISTS idx_onboarding_extractions_item ON onboarding_extractions(item_id);');
        const after = db.query('SELECT COUNT(*) AS cnt FROM onboarding_extractions').get() as { cnt: number };
        const afterIds = (db.query('SELECT id FROM onboarding_extractions ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
        if (after.cnt !== before.cnt || JSON.stringify(afterIds) !== JSON.stringify(beforeIds)) {
          throw new Error('[Migrations] onboarding_extractions rebuild row/ID mismatch');
        }
      }

      // 4) Rebuild classification_evidence when its stored source CHECK lacks
      //    'distributor_record'. Same swap discipline; NO row deletion.
      const ceDdl = db
        .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'classification_evidence'")
        .get() as { sql?: string } | undefined;
      if (ceDdl?.sql && !ceDdl.sql.includes('distributor_record')) {
        const before = db.query('SELECT COUNT(*) AS cnt FROM classification_evidence').get() as { cnt: number };
        const beforeIds = (db.query('SELECT id FROM classification_evidence ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
        db.exec(`
          CREATE TABLE classification_evidence_new (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES classification_runs(id) ON DELETE CASCADE,
            onboarding_item_id TEXT,
            product_sku TEXT NOT NULL,
            stage_name TEXT NOT NULL,
            source TEXT NOT NULL CHECK (source IN ('spreadsheet', 'official_product_page', 'distributor_record', 'third_party_page', 'visual_product_evidence', 'page_context', 'approved_product_example', 'catalog_manager_guidance', 'catalog_product')),
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
        db.exec('INSERT INTO classification_evidence_new SELECT * FROM classification_evidence;');
        db.exec('DROP TABLE classification_evidence;');
        db.exec('ALTER TABLE classification_evidence_new RENAME TO classification_evidence;');
        db.exec('CREATE INDEX IF NOT EXISTS idx_classification_evidence_run ON classification_evidence(run_id);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_classification_evidence_product_source ON classification_evidence(product_sku, source);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_classification_evidence_product ON classification_evidence(product_sku);');
        const after = db.query('SELECT COUNT(*) AS cnt FROM classification_evidence').get() as { cnt: number };
        const afterIds = (db.query('SELECT id FROM classification_evidence ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
        if (after.cnt !== before.cnt || JSON.stringify(afterIds) !== JSON.stringify(beforeIds)) {
          throw new Error('[Migrations] classification_evidence rebuild row/ID mismatch');
        }
      }

      // 5) Rebuild distributor_connections when its stored `enabled` default is
      //    the pre-Amendment-A fail-open DEFAULT 1 (SQLite cannot change a
      //    column default in place). Existing row VALUES are preserved exactly
      //    (operator-controlled connection states are never rewritten); only
      //    the DEFAULT for FUTURE inserts changes to 0.
      const connCols = db.query('PRAGMA table_info(distributor_connections)').all() as Array<{ name: string; dflt_value: string | null }>;
      const enabledCol = connCols.find((c) => c.name === 'enabled');
      if (enabledCol && enabledCol.dflt_value !== '0') {
        const connBefore = db.query('SELECT COUNT(*) AS cnt FROM distributor_connections').get() as { cnt: number };
        const connBeforeIds = (db.query('SELECT id FROM distributor_connections ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
        db.exec(`
          CREATE TABLE distributor_connections_new (
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
        db.exec(`
          INSERT INTO distributor_connections_new
            (id, workspace_id, distributor_id, connector_type, secret_ref, configuration_json, authority_policy_json, enabled, created_at, updated_at)
          SELECT id, workspace_id, distributor_id, connector_type, secret_ref, configuration_json, authority_policy_json, enabled, created_at, updated_at
          FROM distributor_connections;
        `);
        db.exec('DROP TABLE distributor_connections;');
        db.exec('ALTER TABLE distributor_connections_new RENAME TO distributor_connections;');
        db.exec('CREATE INDEX IF NOT EXISTS idx_distributor_connections_workspace ON distributor_connections(workspace_id);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_distributor_connections_distributor ON distributor_connections(distributor_id);');
        const connAfter = db.query('SELECT COUNT(*) AS cnt FROM distributor_connections').get() as { cnt: number };
        const connAfterIds = (db.query('SELECT id FROM distributor_connections ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
        if (connAfter.cnt !== connBefore.cnt || JSON.stringify(connAfterIds) !== JSON.stringify(connBeforeIds)) {
          throw new Error('[Migrations] distributor_connections rebuild row/ID mismatch');
        }
      }

      const fkViolations = db.query('PRAGMA foreign_key_check').all() as Array<{ table: string }>;
      if (fkViolations.length > 0) {
        throw new Error(`[Migrations] default_on_sourcing foreign_key_check failed: ${JSON.stringify(fkViolations.slice(0, 5))}`);
      }
      db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('default_on_sourcing_schema_version', '1');");
    })();
    console.log('[Migrations] Default-On Sourcing schema migration complete.');
  }

  // ── Parent #101: classification_evidence.source CHECK gains
  //    `operator_manual` (manual-evidence extraction route).
  //
  // Own marker-gated block: installations that already recorded
  // `default_on_sourcing_schema_version` never re-run that block, so an
  // `operator_manual` CHECK added there would skip them forever. This block
  // rebuilds the table ONLY when the stored CHECK predates the member,
  // preserves every row value exactly, and writes its marker LAST inside one
  // transaction (`PRAGMA defer_foreign_keys = ON`; any violation rolls back
  // ALL DDL/data and leaves the marker absent). A fresh DB already has the
  // member from the classification SQL file — the block then only validates
  // shape and writes its marker, so fresh and legacy-upgrade DDL converge.
  const manualSourceVersion = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get('manual_evidence_source_schema_version') as { value: string } | undefined;
  const ceManualDdl = db
    .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'classification_evidence'")
    .get() as { sql?: string } | undefined;
  const manualMemberPresent = Boolean(ceManualDdl?.sql && ceManualDdl.sql.includes("'operator_manual'"));
  const manualMarkerCorrect = !manualSourceVersion || manualSourceVersion.value === '1';
  if (manualSourceVersion) {
    // Marker present: the stored CHECK must carry the member and the marker
    // value must match. Drift throws — it is not silently repaired.
    if (!manualMemberPresent || !manualMarkerCorrect) {
      throw new Error('[Migrations] manual_evidence_source marker present but schema drifted (operator_manual CHECK member or marker value missing)');
    }
  } else {
    db.transaction(() => {
      db.exec('PRAGMA defer_foreign_keys = ON');
      if (!manualMemberPresent) {
        const ceBefore = db.query('SELECT COUNT(*) AS cnt FROM classification_evidence').get() as { cnt: number };
        const ceBeforeIds = (db.query('SELECT id FROM classification_evidence ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
        db.exec(`
          CREATE TABLE classification_evidence_new (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES classification_runs(id) ON DELETE CASCADE,
            onboarding_item_id TEXT,
            product_sku TEXT NOT NULL,
            stage_name TEXT NOT NULL,
            source TEXT NOT NULL CHECK (source IN ('spreadsheet', 'official_product_page', 'distributor_record', 'third_party_page', 'visual_product_evidence', 'page_context', 'approved_product_example', 'catalog_manager_guidance', 'catalog_product', 'operator_manual')),
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
        db.exec('INSERT INTO classification_evidence_new SELECT * FROM classification_evidence;');
        db.exec('DROP TABLE classification_evidence;');
        db.exec('ALTER TABLE classification_evidence_new RENAME TO classification_evidence;');
        db.exec('CREATE INDEX IF NOT EXISTS idx_classification_evidence_run ON classification_evidence(run_id);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_classification_evidence_product_source ON classification_evidence(product_sku, source);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_classification_evidence_product ON classification_evidence(product_sku);');
        const ceAfter = db.query('SELECT COUNT(*) AS cnt FROM classification_evidence').get() as { cnt: number };
        const ceAfterIds = (db.query('SELECT id FROM classification_evidence ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
        if (ceAfter.cnt !== ceBefore.cnt || JSON.stringify(ceAfterIds) !== JSON.stringify(ceBeforeIds)) {
          throw new Error('[Migrations] classification_evidence rebuild row/ID mismatch');
        }
      }
      const ceFkViolations = db.query('PRAGMA foreign_key_check').all() as Array<{ table: string }>;
      if (ceFkViolations.length > 0) {
        throw new Error(`[Migrations] manual_evidence_source foreign_key_check failed: ${JSON.stringify(ceFkViolations.slice(0, 5))}`);
      }
      db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('manual_evidence_source_schema_version', '1');");
    })();
    console.log('[Migrations] Manual-evidence source schema migration complete.');
  }

  // ── Amendment B: distributor_connections connector_type CHECK gains
  //    `html_scraper` (Distributor Scraper connectors, ADR 0014 Amendment B).
  //
  // Own marker-gated block: an installation that already recorded
  // `default_on_sourcing_schema_version` (Amendment A) never re-runs that
  // block, so a `html_scraper` CHECK added there would skip it forever. This
  // block rebuilds the table ONLY when the stored CHECK predates the
  // `html_scraper` member (or the `enabled` default is not the current
  // fail-closed 0), preserves every row value exactly, and writes its marker
  // LAST inside one transaction (`PRAGMA defer_foreign_keys = ON`; any
  // violation rolls back ALL DDL/data and leaves the marker absent). A fresh
  // DB already has the correct CHECK from the v2 SQL file — the block then
  // only validates shape and writes its marker, so fresh and legacy-upgrade
  // DDL converge exactly.
  const htmlScraperVersion = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get('distributor_html_scraper_schema_version') as { value: string } | undefined;
  const connDdl = db
    .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'distributor_connections'")
    .get() as { sql?: string } | undefined;
  const connCols = db.query('PRAGMA table_info(distributor_connections)').all() as Array<{ name: string; dflt_value: string | null }>;
  const enabledCol = connCols.find((c) => c.name === 'enabled');
  // Drift validation is EXACT: the stored CHECK must contain precisely the
  // closed connector-type set (any missing OR extra member is drift), and the
  // stored marker value must be the expected '1'.
  const CONNECTOR_TYPE_CHECK_MEMBERS = ['api', 'ftp_catalog', 'csv', 'html_scraper', 'legacy_adapter'];
  function extractCheckMembers(ddl: string | undefined): string[] | null {
    if (!ddl) return null;
    const m = ddl.match(/connector_type\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*connector_type\s+IN\s*\(([^)]*)\)\s*\)/i);
    if (!m) return null;
    const members = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    return members.length > 0 ? members.sort() : null;
  }
  const storedMembers = extractCheckMembers(connDdl?.sql);
  const checkExact = Boolean(storedMembers && JSON.stringify(storedMembers) === JSON.stringify([...CONNECTOR_TYPE_CHECK_MEMBERS].sort()));
  const markerValueCorrect = !htmlScraperVersion || htmlScraperVersion.value === '1';
  const enabledDefaultFailClosed = enabledCol ? enabledCol.dflt_value === '0' : false;
  if (htmlScraperVersion) {
    // Marker present: verify the stored CHECK, enabled default, and marker
    // value match the Amendment B contract exactly. Drift throws — it is not
    // silently repaired.
    if (!checkExact || !enabledDefaultFailClosed || !markerValueCorrect) {
      throw new Error('[Migrations] distributor_html_scraper marker present but schema drifted (exact connector-type CHECK, fail-closed enabled default, or marker value missing)');
    }
  } else {
    db.transaction(() => {
      db.exec('PRAGMA defer_foreign_keys = ON');
      if (!checkExact || !enabledDefaultFailClosed) {
        const connBefore = db.query('SELECT COUNT(*) AS cnt FROM distributor_connections').get() as { cnt: number };
        const connBeforeIds = (db.query('SELECT id FROM distributor_connections ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
        db.exec(`
          CREATE TABLE distributor_connections_new (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspace(id),
            distributor_id TEXT NOT NULL REFERENCES distributors(id) ON DELETE CASCADE,
            connector_type TEXT NOT NULL CHECK (connector_type IN ('api', 'ftp_catalog', 'csv', 'html_scraper', 'legacy_adapter')),
            secret_ref TEXT,
            configuration_json TEXT DEFAULT '{}',
            authority_policy_json TEXT DEFAULT '{}',
            enabled INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
        `);
        db.exec(`
          INSERT INTO distributor_connections_new
            (id, workspace_id, distributor_id, connector_type, secret_ref, configuration_json, authority_policy_json, enabled, created_at, updated_at)
          SELECT id, workspace_id, distributor_id, connector_type, secret_ref, configuration_json, authority_policy_json, enabled, created_at, updated_at
          FROM distributor_connections;
        `);
        db.exec('DROP TABLE distributor_connections;');
        db.exec('ALTER TABLE distributor_connections_new RENAME TO distributor_connections;');
        db.exec('CREATE INDEX IF NOT EXISTS idx_distributor_connections_workspace ON distributor_connections(workspace_id);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_distributor_connections_distributor ON distributor_connections(distributor_id);');
        const connAfter = db.query('SELECT COUNT(*) AS cnt FROM distributor_connections').get() as { cnt: number };
        const connAfterIds = (db.query('SELECT id FROM distributor_connections ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
        if (connAfter.cnt !== connBefore.cnt || JSON.stringify(connAfterIds) !== JSON.stringify(connBeforeIds)) {
          throw new Error('[Migrations] distributor_connections html_scraper rebuild row/ID mismatch');
        }
      }
      const fkViolations = db.query('PRAGMA foreign_key_check').all() as Array<{ table: string }>;
      if (fkViolations.length > 0) {
        throw new Error(`[Migrations] distributor_html_scraper foreign_key_check failed: ${JSON.stringify(fkViolations.slice(0, 5))}`);
      }
      db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('distributor_html_scraper_schema_version', '1');");
    })();
    console.log('[Migrations] Distributor html_scraper schema migration complete.');
  }

  // ── Milestone E: connector-declared variant-axis registry ────────────────
  //
  // Own marker-gated block so installations that already recorded
  // `default_on_sourcing_schema_version` before Milestone E still converge
  // (the previous location inside the default_on_sourcing block would have
  // skipped them forever). Guarded ALTER, idempotent, marker written last.
  const variantAxesVersion = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get('sourcing_variant_axes_schema_version') as { value: string } | undefined;
  if (!variantAxesVersion) {
    db.transaction(() => {
      const axisCols = db.query('PRAGMA table_info(onboarding_evidence_attempts)').all() as Array<{ name: string }>;
      if (!axisCols.some((c) => c.name === 'variant_axis_declarations')) {
        db.exec('ALTER TABLE onboarding_evidence_attempts ADD COLUMN variant_axis_declarations TEXT;');
      }
      const axisFk = db.query('PRAGMA foreign_key_check').all() as Array<{ table: string }>;
      if (axisFk.length > 0) {
        throw new Error(`[Migrations] sourcing_variant_axes foreign_key_check failed: ${JSON.stringify(axisFk.slice(0, 5))}`);
      }
      db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('sourcing_variant_axes_schema_version', '1');");
    })();
    console.log('[Migrations] Sourcing variant-axes schema migration complete.');
  }

  // ── Store Manager runtime audit tables (epic #42, #40) ────────────────────
  //
  // Minimal durable session/turn/event audit for the bounded agent runtime.
  // Everything stored is redacted by construction (digests and bounded scope,
  // never raw prompts, chain of thought, approval secrets/signatures,
  // credentials, absolute paths, or raw tool/network payloads).
  const storeManagerRuntimeVersion = db
    .query("SELECT value FROM app_meta WHERE key = 'store_manager_runtime_schema_version'")
    .get() as { value: string } | undefined;
  if (!storeManagerRuntimeVersion) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS store_manager_sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        thread_id TEXT,
        turn_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        policy_version INTEGER NOT NULL,
        requested_model TEXT,
        resolved_provider TEXT NOT NULL,
        resolved_model TEXT NOT NULL,
        resolved_locality TEXT NOT NULL CHECK (resolved_locality IN ('local', 'cloud')),
        resolution_reason TEXT NOT NULL,
        model_call_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'terminal')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_store_manager_sessions_ws ON store_manager_sessions(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_store_manager_sessions_thread ON store_manager_sessions(thread_id);
      CREATE INDEX IF NOT EXISTS idx_store_manager_sessions_model_call ON store_manager_sessions(model_call_id);

      CREATE TABLE IF NOT EXISTS store_manager_turns (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES store_manager_sessions(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('investigate', 'approve', 'verify')),
        status TEXT NOT NULL CHECK (status IN ('active', 'terminal')),
        terminal_status TEXT CHECK (terminal_status IN ('success', 'failed', 'cancelled', 'policy_denied', 'deadline_exceeded')),
        outcome_reason TEXT,
        total_tool_calls INTEGER NOT NULL DEFAULT 0,
        policy_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_store_manager_turns_ws ON store_manager_turns(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_store_manager_turns_session ON store_manager_turns(session_id);

      CREATE TABLE IF NOT EXISTS store_manager_events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_version INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_store_manager_events_ws ON store_manager_events(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_store_manager_events_session ON store_manager_events(session_id, created_at);
    `);
    db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('store_manager_runtime_schema_version', '1');");
    console.log('[Migrations] Store Manager runtime audit tables migration complete.');
  }

  // ── Agent Training & Alignment schema (Agent Lab) ─────────────────────────
  //
  // Immutable version snapshots, separate lifecycle states, corrections,
  // teaching events, paired evaluation snapshots, and case experiment rows.
  const agentTrainingVersion = db
    .query("SELECT value FROM app_meta WHERE key = 'agent_training_snapshots_schema_version'")
    .get() as { value: string } | undefined;
  if (!agentTrainingVersion) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_version_snapshots (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspace(id),
          version_number INTEGER NOT NULL,
          revision_number INTEGER NOT NULL,
          parent_version_id TEXT REFERENCES agent_version_snapshots(id),
          compiler_version TEXT NOT NULL,
          instructions_json TEXT NOT NULL,
          few_shot_examples_json TEXT NOT NULL,
          few_shot_token_budget INTEGER NOT NULL DEFAULT 4000,
          policy_config_id TEXT NOT NULL,
          content_hash TEXT NOT NULL UNIQUE,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          change_summary TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_agent_version_snapshots_ws ON agent_version_snapshots(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_agent_version_snapshots_num ON agent_version_snapshots(workspace_id, version_number, revision_number);

        CREATE TABLE IF NOT EXISTS agent_version_states (
          version_id TEXT PRIMARY KEY REFERENCES agent_version_snapshots(id) ON DELETE CASCADE,
          workspace_id TEXT NOT NULL REFERENCES workspace(id),
          lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN ('draft', 'evaluating', 'qualified', 'active', 'retired')),
          active_evaluation_id TEXT,
          activated_at TEXT,
          retired_at TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_version_states_ws_status ON agent_version_states(workspace_id, lifecycle_status);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_version_active_per_workspace ON agent_version_states(workspace_id) WHERE lifecycle_status = 'active';

        CREATE TABLE IF NOT EXISTS agent_corrections (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspace(id),
          run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id),
          version_id TEXT NOT NULL REFERENCES agent_version_snapshots(id),
          original_result_hash TEXT NOT NULL,
          corrected_fields_json TEXT NOT NULL,
          failure_mode TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_corrections_ws ON agent_corrections(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_agent_corrections_run ON agent_corrections(run_id);
        CREATE INDEX IF NOT EXISTS idx_agent_corrections_version ON agent_corrections(version_id);

        CREATE TABLE IF NOT EXISTS agent_teaching_events (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspace(id),
          correction_id TEXT NOT NULL REFERENCES agent_corrections(id),
          resulting_version_id TEXT NOT NULL REFERENCES agent_version_snapshots(id),
          actions_json TEXT NOT NULL,
          rationale TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_teaching_events_ws ON agent_teaching_events(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_agent_teaching_events_correction ON agent_teaching_events(correction_id);
        CREATE INDEX IF NOT EXISTS idx_agent_teaching_events_version ON agent_teaching_events(resulting_version_id);

        CREATE TABLE IF NOT EXISTS agent_evaluation_snapshots (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspace(id),
          candidate_version_id TEXT NOT NULL REFERENCES agent_version_snapshots(id),
          baseline_version_id TEXT NOT NULL REFERENCES agent_version_snapshots(id),
          dataset_id TEXT NOT NULL REFERENCES benchmark_datasets(id),
          dataset_hash TEXT NOT NULL,
          split_group TEXT NOT NULL,
          scorecard_json TEXT NOT NULL,
          promotion_gate_verdict_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed', 'cancelled')),
          created_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_agent_eval_snapshots_ws ON agent_evaluation_snapshots(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_agent_eval_snapshots_candidate ON agent_evaluation_snapshots(candidate_version_id);

        CREATE TABLE IF NOT EXISTS agent_evaluation_cases (
          id TEXT PRIMARY KEY,
          evaluation_id TEXT NOT NULL REFERENCES agent_evaluation_snapshots(id) ON DELETE CASCADE,
          workspace_id TEXT NOT NULL REFERENCES workspace(id),
          benchmark_example_id TEXT NOT NULL REFERENCES benchmark_examples(id),
          product_sku TEXT NOT NULL,
          candidate_run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id),
          baseline_run_id TEXT NOT NULL REFERENCES product_intelligence_runs(id),
          candidate_outcome TEXT NOT NULL,
          baseline_outcome TEXT NOT NULL,
          comparison_json TEXT NOT NULL,
          delta_class TEXT NOT NULL CHECK (delta_class IN ('fixed', 'regressed', 'unchanged')),
          critical_regression INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_eval_cases_eval ON agent_evaluation_cases(evaluation_id);
        CREATE INDEX IF NOT EXISTS idx_agent_eval_cases_ws ON agent_evaluation_cases(workspace_id);
      `);

      // Add columns to product_intelligence_runs if missing
      const piCols = db.query('PRAGMA table_info(product_intelligence_runs)').all() as Array<{ name: string }>;
      if (!piCols.some((c) => c.name === 'agent_version_snapshot_id')) {
        db.exec('ALTER TABLE product_intelligence_runs ADD COLUMN agent_version_snapshot_id TEXT REFERENCES agent_version_snapshots(id);');
      }
      if (!piCols.some((c) => c.name === 'agent_version_content_hash')) {
        db.exec('ALTER TABLE product_intelligence_runs ADD COLUMN agent_version_content_hash TEXT;');
      }
      if (!piCols.some((c) => c.name === 'version_role_at_execution')) {
        db.exec("ALTER TABLE product_intelligence_runs ADD COLUMN version_role_at_execution TEXT NOT NULL DEFAULT 'active';");
      }
      if (!piCols.some((c) => c.name === 'import_eligible_at_execution')) {
        db.exec('ALTER TABLE product_intelligence_runs ADD COLUMN import_eligible_at_execution INTEGER NOT NULL DEFAULT 1;');
      }

      // Rebuild benchmark_examples table to expand split_group CHECK constraint
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.transaction(() => {
          db.exec(`
            CREATE TABLE IF NOT EXISTS benchmark_examples_new (
              id TEXT PRIMARY KEY,
              dataset_id TEXT NOT NULL REFERENCES benchmark_datasets(id) ON DELETE CASCADE,
              product_sku TEXT NOT NULL,
              product_family_id TEXT,
              split_group TEXT NOT NULL CHECK (split_group IN ('train', 'test', 'holdout', 'validation', 'promotion_test')),
              input_snapshot_json TEXT NOT NULL,
              gold_labels_json TEXT NOT NULL,
              example_hash TEXT NOT NULL,
              reviewer_id TEXT,
              adjudicated_by TEXT,
              source_run_id TEXT,
              source_config_hash TEXT,
              source_product_hash TEXT,
              is_contaminated INTEGER NOT NULL DEFAULT 0,
              contamination_version_id TEXT,
              created_at TEXT NOT NULL
            );
          `);

          const tableExists = db
            .query("SELECT name FROM sqlite_master WHERE type='table' AND name='benchmark_examples'")
            .get();
          if (tableExists) {
            const cols = (db.query('PRAGMA table_info(benchmark_examples)').all() as Array<{ name: string }>).map((c) => c.name);
            const commonCols = [
              'id', 'dataset_id', 'product_sku', 'product_family_id', 'split_group',
              'input_snapshot_json', 'gold_labels_json', 'example_hash', 'reviewer_id',
              'adjudicated_by', 'source_run_id', 'source_config_hash', 'source_product_hash',
              'is_contaminated', 'contamination_version_id', 'created_at'
            ].filter((col) => cols.includes(col));

            if (commonCols.length > 0) {
              db.exec(`
                INSERT OR IGNORE INTO benchmark_examples_new (${commonCols.join(', ')})
                SELECT ${commonCols.join(', ')}
                FROM benchmark_examples;
              `);
            }
            db.exec('DROP TABLE benchmark_examples;');
          }

          db.exec('ALTER TABLE benchmark_examples_new RENAME TO benchmark_examples;');
          db.exec('CREATE INDEX IF NOT EXISTS idx_benchmark_examples_dataset_split ON benchmark_examples(dataset_id, split_group);');
          db.exec('CREATE INDEX IF NOT EXISTS idx_benchmark_examples_sku ON benchmark_examples(product_sku);');
          db.exec('CREATE INDEX IF NOT EXISTS idx_benchmark_examples_family ON benchmark_examples(product_family_id);');
        })();
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }

      // Seed baseline version v1 for each existing workspace
      const workspaces = db.query('SELECT id FROM workspace').all() as Array<{ id: string }>;
      const nowIso = new Date().toISOString();
      for (const ws of workspaces) {
        const existingActive = db
          .query("SELECT version_id FROM agent_version_states WHERE workspace_id = ? AND lifecycle_status = 'active'")
          .get(ws.id) as { version_id: string } | undefined;
        if (!existingActive) {
          const snapshotId = `v1_rev1_${ws.id}`;
          const policyConfigId = 'default';

          const contentHash = sha256Hex(
            JSON.stringify({
              workspaceId: ws.id,
              versionNumber: 1,
              revisionNumber: 1,
              parentVersionId: null,
              compilerVersion: 'compiler_v1',
              instructions: [],
              fewShotExamples: [],
              fewShotTokenBudget: 4000,
              policyConfigId,
            }),
          );

          db.query(`
            INSERT OR IGNORE INTO agent_version_snapshots (
              id, workspace_id, version_number, revision_number, parent_version_id,
              compiler_version, instructions_json, few_shot_examples_json, few_shot_token_budget,
              policy_config_id, content_hash, created_by, created_at, change_summary
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            snapshotId,
            ws.id,
            1,
            1,
            null,
            'compiler_v1',
            '[]',
            '[]',
            4000,
            policyConfigId,
            contentHash,
            'system',
            nowIso,
            'Initial baseline compiler_v1 version snapshot',
          );

          db.query(`
            INSERT OR IGNORE INTO agent_version_states (
              version_id, workspace_id, lifecycle_status, active_evaluation_id,
              activated_at, retired_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(snapshotId, ws.id, 'active', null, nowIso, null, nowIso);
        }
      }

      const fks = db.query('PRAGMA foreign_key_check').all() as Array<{ table: string }>;
      if (fks.length > 0) {
        throw new Error(`[Migrations] agent_training foreign_key_check failed: ${JSON.stringify(fks.slice(0, 5))}`);
      }
      db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('agent_training_snapshots_schema_version', '1');");
    })();
    console.log('[Migrations] Agent Training & Alignment schema migration complete.');
  }

  // ── Onboarding distributor imagery (epic #46 follow-up, PI-6 reuse) ────
  // Verified distributor images are durable `product_intelligence_assets`
  // rows ORIGINATING from the onboarding pipeline (not a PI run): run_id is
  // relaxed to NULL for these rows, `origin` records the producer, and
  // `onboarding_item_id` links the asset to its item (cascade delete). The
  // same-run candidate trigger only fires when candidate_id is set, so
  // onboarding rows (no candidate) are unaffected. Idempotent per
  // (item, source_url) via a partial unique index.
  try {
    const imageryVersion = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('onboarding_distributor_imagery_schema_version') as { value: string } | undefined;
    if (!imageryVersion) {
      console.log('[Migrations] Running onboarding distributor imagery schema migration...');
      db.transaction(() => {
        // Rebuild the assets table: run_id becomes nullable (onboarding rows
        // carry no PI run); origin + onboarding_item_id are added. Column set
        // mirrors the live table plus the new columns.
        db.exec(`
          CREATE TABLE IF NOT EXISTS product_intelligence_assets_new (
            id TEXT PRIMARY KEY,
            run_id TEXT REFERENCES product_intelligence_runs(id) ON DELETE CASCADE,
            source_id TEXT REFERENCES product_intelligence_sources(id) ON DELETE SET NULL,
            source_url TEXT NOT NULL,
            source_page_url TEXT,
            source_type TEXT NOT NULL,
            source_path TEXT,
            source_artifact_id TEXT,
            extraction_method TEXT NOT NULL CHECK (extraction_method IN ('json_ld', 'platform_api', 'network_response', 'profile_selector', 'media_api', 'manual', 'image_ocr', 'decoder')),
            retrieved_at TEXT NOT NULL,
            original_content_hash TEXT NOT NULL,
            perceptual_hash TEXT,
            variant_reference TEXT,
            rights_status TEXT NOT NULL CHECK (rights_status IN ('approved', 'restricted', 'unknown')),
            rights_basis TEXT,
            rights_evidence_ref TEXT,
            observed_brand TEXT,
            observed_product_name TEXT,
            observed_variant TEXT,
            observed_net_content_json TEXT,
            observed_pack_count INTEGER,
            observed_gtin TEXT,
            exact_product_match INTEGER NOT NULL DEFAULT 0,
            exact_variant_match INTEGER,
            quality_status TEXT NOT NULL CHECK (quality_status IN ('usable', 'low_quality', 'invalid')),
            commerce_approved INTEGER NOT NULL DEFAULT 0,
            conflicts_json TEXT NOT NULL DEFAULT '[]',
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            verified_against_json TEXT,
            verified_against_hash TEXT,
            declared_source_type TEXT,
            candidate_id TEXT,
            brand_evidence_id TEXT,
            brand_evidence_hash TEXT,
            origin TEXT NOT NULL DEFAULT 'pi_run',
            onboarding_item_id TEXT REFERENCES onboarding_items(id) ON DELETE CASCADE
          );
          INSERT INTO product_intelligence_assets_new
            (id, run_id, source_id, source_url, source_page_url, source_type, source_path, source_artifact_id,
             extraction_method, retrieved_at, original_content_hash, perceptual_hash, variant_reference,
             rights_status, rights_basis, rights_evidence_ref, observed_brand, observed_product_name,
             observed_variant, observed_net_content_json, observed_pack_count, observed_gtin,
             exact_product_match, exact_variant_match, quality_status, commerce_approved, conflicts_json,
             payload_json, created_at, verified_against_json, verified_against_hash, declared_source_type,
             candidate_id, brand_evidence_id, brand_evidence_hash, origin, onboarding_item_id)
          SELECT id, run_id, source_id, source_url, source_page_url, source_type, source_path, source_artifact_id,
             extraction_method, retrieved_at, original_content_hash, perceptual_hash, variant_reference,
             rights_status, rights_basis, rights_evidence_ref, observed_brand, observed_product_name,
             observed_variant, observed_net_content_json, observed_pack_count, observed_gtin,
             exact_product_match, exact_variant_match, quality_status, commerce_approved, conflicts_json,
             payload_json, created_at, verified_against_json, verified_against_hash, declared_source_type,
             candidate_id, brand_evidence_id, brand_evidence_hash, 'pi_run', NULL
          FROM product_intelligence_assets;
          DROP TABLE product_intelligence_assets;
          ALTER TABLE product_intelligence_assets_new RENAME TO product_intelligence_assets;
          CREATE INDEX IF NOT EXISTS idx_pi_assets_run ON product_intelligence_assets(run_id);
          CREATE INDEX IF NOT EXISTS idx_pi_assets_commerce ON product_intelligence_assets(run_id, commerce_approved);
          CREATE INDEX IF NOT EXISTS idx_pi_assets_onboarding_item ON product_intelligence_assets(onboarding_item_id);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_pi_assets_onboarding_url
            ON product_intelligence_assets(onboarding_item_id, source_url)
            WHERE origin = 'onboarding_distributor' AND onboarding_item_id IS NOT NULL;
        `);
        // Recreate the same-run candidate trigger (dropped with the table).
        const candidateRunTrigger = db
          .query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_pi_asset_candidate_same_run'")
          .get();
        if (!candidateRunTrigger) {
          db.exec(`
            CREATE TRIGGER trg_pi_asset_candidate_same_run
            BEFORE INSERT ON product_intelligence_assets
            WHEN NEW.candidate_id IS NOT NULL
            BEGIN
              SELECT CASE
                WHEN NOT EXISTS (SELECT 1 FROM pi_image_candidates WHERE id = NEW.candidate_id)
                  THEN RAISE(ABORT, 'candidate_id references a nonexistent pi_image_candidates row')
                WHEN (SELECT run_id FROM pi_image_candidates WHERE id = NEW.candidate_id) <> NEW.run_id
                  THEN RAISE(ABORT, 'candidate_id belongs to a different run')
              END;
            END;`);
        }
      })();
      const fkViolations = db.query("PRAGMA foreign_key_check('product_intelligence_assets')").all();
      if (fkViolations.length > 0) {
        console.warn(`[Migrations] ${fkViolations.length} FK violations in product_intelligence_assets after imagery rebuild (pre-existing):`, fkViolations.slice(0, 5));
      }
      db.exec("INSERT INTO app_meta (key, value) VALUES ('onboarding_distributor_imagery_schema_version', '1');");
      console.log('[Migrations] Onboarding distributor imagery schema migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Onboarding distributor imagery schema migration failed:', e);
    throw e;
  }

  // ── ProductSeed v2 run input (issue #50) ─────────────────────────────────
  // Additive columns preserve historical GTIN-first input_json verbatim while
  // giving v2 runs separately inspectable immutable seed and non-authoritative
  // batch context snapshots.
  const piSeedVersion = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get('product_intelligence_seed_schema_version') as { value: string } | undefined;
  if (!piSeedVersion) {
    db.transaction(() => {
      const cols = db.query('PRAGMA table_info(product_intelligence_runs)').all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'product_seed_json')) {
        db.exec('ALTER TABLE product_intelligence_runs ADD COLUMN product_seed_json TEXT;');
      }
      if (!cols.some((c) => c.name === 'batch_context_json')) {
        db.exec('ALTER TABLE product_intelligence_runs ADD COLUMN batch_context_json TEXT;');
      }
      if (!cols.some((c) => c.name === 'input_schema_version')) {
        db.exec('ALTER TABLE product_intelligence_runs ADD COLUMN input_schema_version INTEGER NOT NULL DEFAULT 1;');
      }
    })();
    db.exec("INSERT INTO app_meta (key, value) VALUES ('product_intelligence_seed_schema_version', '1');");
  }

  // ── Cohort-curation shadow observations (epic #46 review round, Package B) ─
  // PR4 C5 shadow mode currently logs the deterministic cohort Execution
  // Product Type resolution and writes NOTHING — no durable artifact to
  // evaluate family grouping / type quality after a live batch. This table
  // persists one row per cohort per state CHANGE (caller dedupes), so the
  // next shadow-enabled batch is measurable. Additive + idempotent.
  const cohortShadowVersion = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get('onboarding_cohort_shadow_schema_version') as { value: string } | undefined;
  if (!cohortShadowVersion) {
    console.log('[Migrations] Running onboarding cohort shadow observations schema migration...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS cohort_shadow_observations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        cohort_id TEXT NOT NULL,
        group_key TEXT,
        group_label TEXT,
        status TEXT,
        member_count INTEGER NOT NULL DEFAULT 0,
        ready_count INTEGER NOT NULL DEFAULT 0,
        execution_type_id TEXT,
        product_type_confidence REAL,
        outcome TEXT,
        members_json TEXT,
        grouping_version TEXT,
        observed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cohort_shadow_obs_ws_time
        ON cohort_shadow_observations(workspace_id, observed_at DESC);
    `);
    db.exec("INSERT INTO app_meta (key, value) VALUES ('onboarding_cohort_shadow_schema_version', '1');");
    console.log('[Migrations] Cohort shadow observations schema migration complete.');
  }

  // ── Profile Engineer domain workflow leases (epic #47, issue #51) ───────
  // One durable row per normalized source domain prevents concurrent blocked
  // products from starting duplicate proposal/validation workflows. The row is
  // proposal state only; extractor_profiles remains governed by Profile Builder
  // and the existing profile promoter.
  const profileEngineerVersion = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get('profile_engineer_workflow_schema_version') as { value: string } | undefined;
  const workflowColumns = db.query('PRAGMA table_info(profile_engineer_domain_workflows)').all() as Array<{ name: string }>;
  const hasWorkflowTable = workflowColumns.length > 0;
  const hasWorkspaceColumn = workflowColumns.some((column) => column.name === 'workspace_id');
  if (!hasWorkflowTable || !hasWorkspaceColumn) {
    const legacyWorkspace = (db.query('SELECT id FROM workspace ORDER BY rowid ASC LIMIT 1').get() as { id: string } | undefined)?.id ?? 'legacy';
    db.transaction(() => {
      if (hasWorkflowTable) db.exec('ALTER TABLE profile_engineer_domain_workflows RENAME TO profile_engineer_domain_workflows_legacy');
      db.exec(`
        CREATE TABLE profile_engineer_domain_workflows (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          domain TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
          run_id TEXT NOT NULL,
          lease_expires_at TEXT,
          generation_id TEXT,
          revision_id TEXT,
          artifact_json TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(workspace_id, domain)
        );
      `);
      if (hasWorkflowTable) {
        db.query(`INSERT INTO profile_engineer_domain_workflows
          (id, workspace_id, domain, status, run_id, lease_expires_at, generation_id, artifact_json, error_message, created_at, updated_at)
          SELECT id, ?, domain, status, run_id, lease_expires_at, generation_id, artifact_json, error_message, created_at, updated_at
          FROM profile_engineer_domain_workflows_legacy`).run(legacyWorkspace);
        db.exec('DROP TABLE profile_engineer_domain_workflows_legacy');
      }
    })();
  } else {
    const hasRevisionColumn = workflowColumns.some((column) => column.name === 'revision_id');
    if (!hasRevisionColumn) db.exec('ALTER TABLE profile_engineer_domain_workflows ADD COLUMN revision_id TEXT');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_profile_engineer_workflows_status
      ON profile_engineer_domain_workflows(workspace_id, status, lease_expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_engineer_workflows_workspace_domain
      ON profile_engineer_domain_workflows(workspace_id, domain);
  `);
  if (!profileEngineerVersion) {
    db.exec("INSERT INTO app_meta (key, value) VALUES ('profile_engineer_workflow_schema_version', '2');");
  } else if (Number(profileEngineerVersion.value) < 2) {
    db.query("UPDATE app_meta SET value = '2' WHERE key = 'profile_engineer_workflow_schema_version'").run();
  }

  // ── Brand URL Index & Sitemap Health (epic #61) ──────────────────────────
  const brandUrlIndexVersion = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get('brand_url_index_schema_version') as { value: string } | undefined;

  if (!brandUrlIndexVersion) {
    console.log('[Migrations] Running brand URL index & sitemap health schema migration...');
    db.transaction(() => {
      // 1. Persistent brand URL inventory
      db.exec(`
        CREATE TABLE IF NOT EXISTS brand_url_index (
          id TEXT PRIMARY KEY,
          domain TEXT NOT NULL,
          url TEXT NOT NULL,
          canonical_url TEXT,
          path TEXT NOT NULL,
          slug TEXT,
          page_type TEXT NOT NULL DEFAULT 'product',
          sitemap_source_url TEXT,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          last_sitemap_refresh_at TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          lastmod TEXT,
          title TEXT,
          h1 TEXT,
          upc TEXT,
          sku TEXT,
          mpn TEXT,
          brand TEXT,
          variant_tokens_json TEXT,
          json_ld_identifiers_json TEXT,
          last_fetched_at TEXT,
          extraction_status TEXT
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_url_index_domain_url
          ON brand_url_index(domain, url);
        CREATE INDEX IF NOT EXISTS idx_brand_url_index_domain_active
          ON brand_url_index(domain, active);
        CREATE INDEX IF NOT EXISTS idx_brand_url_index_upc
          ON brand_url_index(upc);
        CREATE INDEX IF NOT EXISTS idx_brand_url_index_sku
          ON brand_url_index(sku);
        CREATE INDEX IF NOT EXISTS idx_brand_url_index_domain_page_type
          ON brand_url_index(domain, page_type);
      `);

      // 2. FTS5 table for fast lexical / token matching
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS brand_url_fts USING fts5(
          domain UNINDEXED,
          url,
          path,
          slug,
          title,
          h1,
          brand,
          tokenize='unicode61 remove_diacritics 2'
        );
      `);

      // 3. Sitemap refresh history
      db.exec(`
        CREATE TABLE IF NOT EXISTS sitemap_refresh_history (
          id TEXT PRIMARY KEY,
          domain TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('success', 'failed', 'blocked')),
          source_url TEXT,
          total_urls_observed INTEGER NOT NULL DEFAULT 0,
          product_urls_eligible INTEGER NOT NULL DEFAULT 0,
          added_count INTEGER NOT NULL DEFAULT 0,
          updated_count INTEGER NOT NULL DEFAULT 0,
          inactivated_count INTEGER NOT NULL DEFAULT 0,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          error_message TEXT,
          http_status INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_sitemap_refresh_history_domain_completed
          ON sitemap_refresh_history(domain, completed_at DESC);
      `);

      // 4. Sitemap discovery events
      db.exec(`
        CREATE TABLE IF NOT EXISTS sitemap_discovery_events (
          id TEXT PRIMARY KEY,
          item_id TEXT,
          upc TEXT,
          domain TEXT,
          created_at TEXT NOT NULL,
          satisfied_locally INTEGER NOT NULL,
          candidate_url TEXT,
          confidence REAL,
          source_method TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_sitemap_discovery_events_domain_created
          ON sitemap_discovery_events(domain, created_at);
      `);

      // Backfill from sitemap_cache if existing rows exist
      try {
        const existingCacheRows = db.query(
          'SELECT domain, urls_json, fetched_at, source_url FROM sitemap_cache'
        ).all() as Array<{ domain: string; urls_json: string; fetched_at: string; source_url: string | null }>;

        const insertStmt = db.prepare(`
          INSERT OR IGNORE INTO brand_url_index (
            id, domain, url, path, slug, page_type, sitemap_source_url,
            first_seen_at, last_seen_at, last_sitemap_refresh_at, active
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `);

        const ftsInsert = db.prepare(`
          INSERT INTO brand_url_fts (rowid, domain, url, path, slug, title, h1, brand)
          SELECT rowid, domain, url, path, slug, title, h1, brand FROM brand_url_index WHERE url = ?
        `);

        for (const row of existingCacheRows) {
          try {
            const urls = JSON.parse(row.urls_json);
            if (Array.isArray(urls)) {
              for (const u of urls) {
                if (typeof u !== 'string' || !u.startsWith('http')) continue;
                try {
                  const parsedUrl = new URL(u);
                  const path = parsedUrl.pathname;
                  const segments = path.split('/').filter(Boolean);
                  const slug = segments[segments.length - 1] || '';
                  const id = `bui_${crypto.randomUUID()}`;
                  insertStmt.run(
                    id,
                    row.domain.toLowerCase().replace(/^www\./, ''),
                    u,
                    path,
                    slug,
                    'product',
                    row.source_url,
                    row.fetched_at || new Date().toISOString(),
                    row.fetched_at || new Date().toISOString(),
                    row.fetched_at || new Date().toISOString(),
                  );
                  ftsInsert.run(u);
                } catch {
                  // ignore malformed URL
                }
              }
            }
          } catch {
            // ignore malformed cache JSON
          }
        }
      } catch {
        // sitemap_cache table may not exist or be empty
      }

      db.exec("INSERT INTO app_meta (key, value) VALUES ('brand_url_index_schema_version', '1');");
    })();
    console.log('[Migrations] Brand URL index & sitemap health schema migration complete.');
  }

  // ── Seed default / known brand sites mapping ──
  const brandSitesSeedVersion = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get('brand_sites_seed_version') as { value: string } | undefined;
  if (!brandSitesSeedVersion || parseInt(brandSitesSeedVersion.value, 10) < 2) {
    console.log('[Migrations] Seeding expanded brand sites mappings...');
    const now = new Date().toISOString();
    const seedMappings: Array<{ brandName: string; domain: string }> = [
      // Core & Previous
      { brandName: 'The Honest Kitchen', domain: 'thehonestkitchen.com' },
      { brandName: 'Honest Kitchen', domain: 'thehonestkitchen.com' },
      { brandName: 'Woof', domain: 'mywoof.com' },
      { brandName: 'My Woof', domain: 'mywoof.com' },
      { brandName: 'Earth Animal', domain: 'earthanimal.com' },
      { brandName: 'Instinct', domain: 'instinctpetfood.com' },
      { brandName: "Stella & Chewy's", domain: 'stellaandchewys.com' },
      { brandName: 'Stella & Chewys', domain: 'stellaandchewys.com' },
      { brandName: 'Polkadog', domain: 'polkadog.com' },
      { brandName: 'Polka Dog Bakery', domain: 'polkadog.com' },
      { brandName: 'Manna Pro', domain: 'mannapro.com' },
      { brandName: "Nature's Way", domain: 'natureswaybirds.com' },
      { brandName: 'Natures Way', domain: 'natureswaybirds.com' },
      { brandName: 'The Missing Link', domain: 'missinglinkproducts.com' },
      { brandName: 'Missing Link', domain: 'missinglinkproducts.com' },
      { brandName: 'Koha', domain: 'kohapet.com' },
      { brandName: 'Dr. Marty', domain: 'drmartypets.com' },
      { brandName: 'Dr Marty', domain: 'drmartypets.com' },
      { brandName: 'Company of Animals', domain: 'companyofanimals.com' },
      { brandName: 'The Company of Animals', domain: 'companyofanimals.com' },
      { brandName: 'Rescue', domain: 'rescue.com' },
      { brandName: 'Blue Buffalo', domain: 'bluebuffalo.com' },
      { brandName: 'Blue', domain: 'bluebuffalo.com' },
      { brandName: 'Purina', domain: 'purina.com' },
      { brandName: 'Pro Plan', domain: 'purina.com' },
      { brandName: 'Friskies', domain: 'purina.com' },

      // Top catalog brands (Ranks 1-50)
      { brandName: 'Kong', domain: 'kongcompany.com' },
      { brandName: 'KONG', domain: 'kongcompany.com' },
      { brandName: 'Coastal', domain: 'coastalpet.com' },
      { brandName: 'Coastal Pet Products', domain: 'coastalpet.com' },
      { brandName: 'Meadow Candle', domain: 'meadowcandle.com' },
      { brandName: 'Kaytee', domain: 'kaytee.com' },
      { brandName: 'Fromm', domain: 'frommfamily.com' },
      { brandName: 'Fromm Family Foods', domain: 'frommfamily.com' },
      { brandName: 'Boss Dog', domain: 'bossdogbrand.com' },
      { brandName: 'Nylabone', domain: 'nylabone.com' },
      { brandName: 'NutriSource', domain: 'nutrisourcepetfoods.com' },
      { brandName: 'PureVita', domain: 'nutrisourcepetfoods.com' },
      { brandName: 'Blue Seal', domain: 'blueseal.com' },
      { brandName: 'Hamilton', domain: 'bngmiraclepet.com' },
      { brandName: 'Lake Valley Seed', domain: 'lakevalleyseed.com' },
      { brandName: 'Merrick', domain: 'merrickpetcare.com' },
      { brandName: 'Ferry Morse', domain: 'ferrymorse.com' },
      { brandName: 'Ferry-Morse', domain: 'ferrymorse.com' },
      { brandName: 'Open Farm', domain: 'openfarmpet.com' },
      { brandName: 'Wellness', domain: 'wellnesspetfood.com' },
      { brandName: 'Redbarn', domain: 'redbarn.com' },
      { brandName: 'Berne', domain: 'berneapparel.com' },
      { brandName: 'Berne Apparel', domain: 'berneapparel.com' },
      { brandName: 'Little Giant', domain: 'miller-mfg.com' },
      { brandName: 'Barkworthies', domain: 'barkworthies.com' },
      { brandName: 'Preppy Puppy', domain: 'preppypuppytreats.com' },
      { brandName: 'Preppy Puppy Bakery', domain: 'preppypuppytreats.com' },
      { brandName: 'Triumph', domain: 'triumphtreats.com' },
      { brandName: 'Tiki', domain: 'tikipets.com' },
      { brandName: 'Tiki Cat', domain: 'tikipets.com' },
      { brandName: 'Tiki Dog', domain: 'tikipets.com' },
      { brandName: 'Jonathan Green', domain: 'jonathangreen.com' },
      { brandName: 'Natural Balance', domain: 'naturalbalanceinc.com' },
      { brandName: 'Weruva', domain: 'weruva.com' },
      { brandName: 'BFF', domain: 'weruva.com' },
      { brandName: 'Canidae', domain: 'canidae.com' },
      { brandName: 'Tetra', domain: 'tetra-fish.com' },
      { brandName: 'Chicken Soup', domain: 'chickensouppets.com' },
      { brandName: 'Earthborn', domain: 'earthbornholisticpetfood.com' },
      { brandName: 'Earthborn Holistic', domain: 'earthbornholisticpetfood.com' },
      { brandName: "Nature's Miracle", domain: 'naturesmiracle.com' },
      { brandName: 'Natures Miracle', domain: 'naturesmiracle.com' },
      { brandName: 'MyFamily', domain: 'myfamily.it' },
      { brandName: 'PLAY', domain: 'petplay.com' },
      { brandName: 'P.L.A.Y.', domain: 'petplay.com' },
      { brandName: 'Schleich', domain: 'schleich-s.com' },
      { brandName: 'Bonide', domain: 'bonide.com' },
      { brandName: 'Primal', domain: 'primalpetfoods.com' },
      { brandName: 'Spot', domain: 'ethicalpet.com' },
      { brandName: 'Ethical Pet', domain: 'ethicalpet.com' },
      { brandName: 'Four Paws', domain: 'fourpaws.com' },
      { brandName: 'Wee-Wee', domain: 'fourpaws.com' },
      { brandName: 'Magic Coat', domain: 'fourpaws.com' },
      { brandName: 'Greenies', domain: 'greenies.com' },
      { brandName: 'Chuckit!', domain: 'petmate.com' },
      { brandName: 'Petmate', domain: 'petmate.com' },
      { brandName: 'JW Pet', domain: 'petmate.com' },
      { brandName: 'C&S', domain: 'wildbirdsuet.com' },
      { brandName: 'C&S Products', domain: 'wildbirdsuet.com' },
      { brandName: 'Nulo', domain: 'nulo.com' },
      { brandName: 'Inaba', domain: 'inabafoods.com' },
      { brandName: 'Inaba Churu', domain: 'inabafoods.com' },
      { brandName: 'Tuffy', domain: 'dogtuff.com' },
      { brandName: 'TropiClean', domain: 'tropiclean.com' },
      { brandName: 'Tropiclean', domain: 'tropiclean.com' },
      { brandName: 'Farnam', domain: 'farnam.com' },
      { brandName: 'Droll Yankees', domain: 'drollyankees.com' },
      { brandName: 'NaturVet', domain: 'naturvet.com' },
      { brandName: 'Naturvet', domain: 'naturvet.com' },
      { brandName: 'Canada Pooch', domain: 'canadapooch.com' },
      { brandName: 'GURU', domain: 'gurupetcompany.com' },

      // Next tier catalog brands (Ranks 51-120)
      { brandName: 'Acana', domain: 'acana.com' },
      { brandName: "Hill's", domain: 'hillspet.com' },
      { brandName: 'Science Diet', domain: 'hillspet.com' },
      { brandName: "Hill's Science Diet", domain: 'hillspet.com' },
      { brandName: 'Zoo-Med', domain: 'zoomed.com' },
      { brandName: 'Zoo Med', domain: 'zoomed.com' },
      { brandName: 'Fox Farm', domain: 'foxfarm.com' },
      { brandName: 'FoxFarm', domain: 'foxfarm.com' },
      { brandName: 'Van Ness', domain: 'vannesspets.com' },
      { brandName: 'Furminator', domain: 'furminator.com' },
      { brandName: 'FURminator', domain: 'furminator.com' },
      { brandName: 'Zignature', domain: 'zignature.com' },
      { brandName: 'Poulin', domain: 'poulingrain.com' },
      { brandName: 'Poulin Grain', domain: 'poulingrain.com' },
      { brandName: 'Pro Pac', domain: 'propacultimates.com' },
      { brandName: "Zuke's", domain: 'zukes.com' },
      { brandName: 'Zukes', domain: 'zukes.com' },
      { brandName: 'Zippy Paws', domain: 'zippypaws.com' },
      { brandName: 'ZippyPaws', domain: 'zippypaws.com' },
      { brandName: 'Cadet', domain: 'cadetpet.com' },
      { brandName: 'Nutro', domain: 'nutro.com' },
      { brandName: 'Espoma', domain: 'espoma.com' },
      { brandName: 'Happy Hen', domain: 'happyhentreats.com' },
      { brandName: 'Bentley Seeds', domain: 'bentleyseeds.com' },
      { brandName: 'Feathered Friend', domain: 'agway.com' },
      { brandName: 'Wild Delight', domain: 'wilddelight.com' },
      { brandName: 'Muck Boot', domain: 'muckbootcompany.com' },
      { brandName: 'Durvet', domain: 'durvet.com' },
      { brandName: 'Agway', domain: 'agway.com' },
      { brandName: 'Benebone', domain: 'benebone.com' },
      { brandName: 'Optimeal', domain: 'optimeal.com' },
      { brandName: 'Mammoth', domain: 'mammothpet.com' },
      { brandName: 'Orijen', domain: 'orijenpetfoods.com' },
      { brandName: 'Wholesomes', domain: 'wholesomespetfood.com' },
      { brandName: 'Crave', domain: 'cravepetfoods.com' },
      { brandName: 'ZuPreem', domain: 'zupreem.com' },
      { brandName: 'Zupreem', domain: 'zupreem.com' },
      { brandName: 'Absorbine', domain: 'absorbine.com' },
      { brandName: 'Mazuri', domain: 'mazuri.com' },
      { brandName: 'Multipet', domain: 'multipet.com' },
      { brandName: 'Taste Of The Wild', domain: 'tasteofthewildpetfood.com' },
      { brandName: 'Taste of the Wild', domain: 'tasteofthewildpetfood.com' },
      { brandName: 'Freshpet', domain: 'freshpet.com' },
      { brandName: 'Fussie Cat', domain: 'fussiecat.com' },
      { brandName: 'Sloggers', domain: 'sloggers.com' },
      { brandName: 'Etta Says', domain: 'ettasays.com' },
      { brandName: 'Etta Says!', domain: 'ettasays.com' },
      { brandName: 'Perky Pet', domain: 'perkypet.com' },
      { brandName: 'Perky-Pet', domain: 'perkypet.com' },
      { brandName: 'PetSafe', domain: 'petsafe.com' },
      { brandName: 'Farmland Traditions', domain: 'farmlandtraditions.com' },
      { brandName: 'Motomco', domain: 'motomco.com' },
      { brandName: 'Dogs Gone Smart', domain: 'dgspetproducts.com' },
      { brandName: 'Old Mother Hubbard', domain: 'oldmotherhubbard.com' },
      { brandName: "Tucker's", domain: 'mytuckers.com' },
      { brandName: 'Tuckers', domain: 'mytuckers.com' },
      { brandName: 'Plato', domain: 'platopettreats.com' },
      { brandName: 'Iams', domain: 'iams.com' },
      { brandName: 'Standlee', domain: 'standleeforage.com' },
      { brandName: 'Midwest', domain: 'midwesthomes4pets.com' },
      { brandName: 'Grizzly', domain: 'grizzlypetproducts.com' },
      { brandName: 'Alcott', domain: 'alcottadventures.com' },
      { brandName: 'North States', domain: 'northstatesind.com' },
      { brandName: 'Thermacell', domain: 'thermacell.com' },
      { brandName: 'Ball', domain: 'ballmasonjars.com' },
      { brandName: 'Outward Hound', domain: 'outwardhound.com' },
      { brandName: 'Oxbow', domain: 'oxbowanimalhealth.com' },
      { brandName: 'HomeoPet', domain: 'homeopet.com' },
      { brandName: 'Homeopet', domain: 'homeopet.com' },
      { brandName: 'Farm Innovators', domain: 'farminnovators.com' },
      { brandName: 'Icelandic+', domain: 'icelandicplus.com' },
      { brandName: 'Catit', domain: 'catit.com' },
      { brandName: 'Earthbath', domain: 'earthbath.com' },
      { brandName: 'Pet Plate', domain: 'petplate.com' },
      { brandName: 'Ware', domain: 'warepet.com' },
      { brandName: 'True Chews', domain: 'truechews.com' },
      { brandName: 'Cesar', domain: 'cesar.com' },
      { brandName: 'Bil Jac', domain: 'bil-jac.com' },
      { brandName: 'Bil-Jac', domain: 'bil-jac.com' },
      { brandName: 'Temptations', domain: 'temptationstreats.com' },
      { brandName: "World's Best", domain: 'worldsbestcatlitter.com' },
      { brandName: 'Worlds Best', domain: 'worldsbestcatlitter.com' },
      { brandName: 'K9 Granola Factory', domain: 'k9granolafactory.com' },
      { brandName: 'Royal Canin', domain: 'royalcanin.com' },
      { brandName: 'Fiskars', domain: 'fiskars.com' },
      { brandName: 'Yeowww!', domain: 'yeowww.com' },
      { brandName: 'Yeowww', domain: 'yeowww.com' },
      { brandName: 'Starmark', domain: 'starmarkacademy.com' },
      { brandName: 'Coast Of Maine', domain: 'coastofmaine.com' },
      { brandName: 'FirstMate', domain: 'firstmate.com' },
      { brandName: 'LickiMat', domain: 'lickimat.com' },
      { brandName: 'Milk-Bone', domain: 'milkbone.com' },
      { brandName: 'Milkbone', domain: 'milkbone.com' },
      { brandName: 'Pet Botanics', domain: 'petbotanics.com' },
      { brandName: 'Okocat', domain: 'healthy-pet.com' },
      { brandName: 'Melnor', domain: 'melnor.com' },
      { brandName: 'Zilla', domain: 'zillarules.com' },
      { brandName: "Bosco & Roxy's", domain: 'boscoandroxys.com' },
      { brandName: 'Flexi', domain: 'flexi-northamerica.com' },
      { brandName: 'K&H', domain: 'khpet.com' },
      { brandName: 'Stewart', domain: 'stewartpet.com' },
    ];

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO brand_sites (id, brand_name, domain, success_count, created_at)
      VALUES (?, ?, ?, 1, ?)
    `);

    for (const m of seedMappings) {
      const normBrand = m.brandName.toLowerCase().trim();
      const normDomain = m.domain.toLowerCase().replace(/^www\./, '').trim();
      const id = randomUUID();
      insertStmt.run(id, normBrand, normDomain, now);
    }

    // Backfill brand into brand_url_index and rebuild FTS if table exists
    try {
      const updateUrlBrandStmt = db.prepare(`
        UPDATE brand_url_index
        SET brand = ?
        WHERE domain = ? AND (brand IS NULL OR brand = '')
      `);
      for (const m of seedMappings) {
        const normDomain = m.domain.toLowerCase().replace(/^www\./, '').trim();
        updateUrlBrandStmt.run(m.brandName, normDomain);
      }
      db.exec("INSERT INTO brand_url_fts(brand_url_fts) VALUES('rebuild');");
    } catch {
      // ignore if brand_url_index doesn't exist yet
    }

    db.exec(`
      INSERT INTO app_meta (key, value)
      VALUES ('brand_sites_seed_version', '2')
      ON CONFLICT(key) DO UPDATE SET value = '2';
    `);
    console.log('[Migrations] Brand sites mapping seed complete (version 2).');
  }

  // ── Batch Preflight & Controlled Release schema ────────────────────────────
  const batchPreflightVersion = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get('batch_preflight_schema_version') as { value: string } | undefined;
  if (!batchPreflightVersion) {
    db.transaction(() => {
      // 1. onboarding_batches.execution_state
      const batchCols = db.query('PRAGMA table_info(onboarding_batches)').all() as Array<{ name: string }>;
      if (!batchCols.some((c) => c.name === 'execution_state')) {
        db.exec("ALTER TABLE onboarding_batches ADD COLUMN execution_state TEXT NOT NULL DEFAULT 'draft'");
        // Backfill existing batches: active -> running, archived -> completed
        db.exec("UPDATE onboarding_batches SET execution_state = CASE WHEN status = 'archived' THEN 'completed' ELSE 'running' END");
      }

      // 2. onboarding_items.is_held, held_reason
      const itemCols = db.query('PRAGMA table_info(onboarding_items)').all() as Array<{ name: string }>;
      if (!itemCols.some((c) => c.name === 'is_held')) {
        db.exec('ALTER TABLE onboarding_items ADD COLUMN is_held INTEGER NOT NULL DEFAULT 0');
      }
      if (!itemCols.some((c) => c.name === 'held_reason')) {
        db.exec('ALTER TABLE onboarding_items ADD COLUMN held_reason TEXT');
      }

      // 3. brand_advisory_profiles.sourcing_policy
      // Issue #150: skip when retirement already dropped the table (an
      // absent table means retired, never a cue to recreate it).
      const brandCols = db.query('PRAGMA table_info(brand_advisory_profiles)').all() as Array<{ name: string }>;
      if (brandCols.length > 0 && !brandCols.some((c) => c.name === 'sourcing_policy')) {
        db.exec("ALTER TABLE brand_advisory_profiles ADD COLUMN sourcing_policy TEXT NOT NULL DEFAULT 'advisory'");
      }

      db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('batch_preflight_schema_version', '1')");
      db.exec("UPDATE app_meta SET value = '1' WHERE key = 'batch_preflight_schema_version'");
    })();
    console.log('[Migrations] Batch preflight and controlled release migration complete.');
  }

  // ── Sourcing Decision V2 Schema Repair Migration ───────────────────────────
  const sourcingDecisionRepairVersion = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get('sourcing_decision_repair_version') as { value: string } | undefined;
  if (!sourcingDecisionRepairVersion) {
    db.transaction(() => {
      const items = db
        .query('SELECT id, sourcing_decision_json FROM onboarding_items WHERE sourcing_decision_json IS NOT NULL')
        .all() as Array<{ id: string; sourcing_decision_json: string }>;
      const updateStmt = db.prepare('UPDATE onboarding_items SET sourcing_decision_json = ? WHERE id = ?');

      for (const item of items) {
        try {
          const parsed = JSON.parse(item.sourcing_decision_json) as Record<string, unknown>;
          if (parsed && typeof parsed === 'object' && (parsed.schemaVersion === 2 || ('route' in parsed && typeof parsed.route === 'string'))) {
            const route = parsed.route as string;
            const origin = typeof parsed.origin === 'string' ? parsed.origin : 'automatic_policy';
            const decidedAt = typeof parsed.decidedAt === 'string' ? parsed.decidedAt : new Date().toISOString();
            const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
            const conflicts = Array.isArray(parsed.conflicts) ? parsed.conflicts : [];

            let changed = false;
            let updatedDecision: Record<string, unknown> | null = null;

            if (route === 'evidence_to_discovery') {
              const acceptedAttemptIds = Array.isArray(parsed.acceptedEvidenceAttemptIds) ? parsed.acceptedEvidenceAttemptIds : [];
              const providerIds = Array.isArray(parsed.providerIds) ? parsed.providerIds : [];
              const genId = typeof parsed.sourcingGenerationId === 'string' ? parsed.sourcingGenerationId : null;

              if (acceptedAttemptIds.length === 0 || providerIds.length === 0 || !genId) {
                updatedDecision = {
                  schemaVersion: 2,
                  route: 'fallback_to_discovery',
                  origin,
                  acceptedEvidenceAttemptIds: [],
                  providerIds: [],
                  sourcingGenerationId: genId ?? undefined,
                  sourceType: 'official_page',
                  target: 'discovery',
                  conflicts,
                  warnings,
                  decidedAt,
                };
                changed = true;
              } else if (!parsed.sourceType || !parsed.target) {
                updatedDecision = {
                  schemaVersion: 2,
                  route: 'evidence_to_discovery',
                  origin,
                  acceptedEvidenceAttemptIds: acceptedAttemptIds,
                  providerIds,
                  sourcingGenerationId: genId,
                  sourceType: 'official_page',
                  target: 'discovery',
                  conflicts,
                  warnings,
                  decidedAt,
                };
                changed = true;
              }
            } else if (route === 'fallback_to_discovery') {
              if (!parsed.sourceType || !parsed.target) {
                updatedDecision = {
                  schemaVersion: 2,
                  route: 'fallback_to_discovery',
                  origin,
                  acceptedEvidenceAttemptIds: [],
                  providerIds: Array.isArray(parsed.providerIds) ? parsed.providerIds : [],
                  sourcingGenerationId: typeof parsed.sourcingGenerationId === 'string' ? parsed.sourcingGenerationId : undefined,
                  sourceType: 'official_page',
                  target: 'discovery',
                  conflicts,
                  warnings,
                  decidedAt,
                };
                changed = true;
              }
            } else if (route === 'degraded_fallback_to_discovery') {
              if (!parsed.sourceType || !parsed.target || !parsed.sourcingGenerationId) {
                const providerIds = Array.isArray(parsed.providerIds) && parsed.providerIds.length > 0 ? parsed.providerIds : ['unknown'];
                updatedDecision = {
                  schemaVersion: 2,
                  route: 'degraded_fallback_to_discovery',
                  origin,
                  acceptedEvidenceAttemptIds: [],
                  providerIds,
                  sourcingGenerationId: typeof parsed.sourcingGenerationId === 'string' ? parsed.sourcingGenerationId : 'legacy',
                  sourceType: 'official_page',
                  target: 'discovery',
                  conflicts,
                  warnings,
                  decidedAt,
                };
                changed = true;
              }
            }

            if (changed && updatedDecision) {
              updateStmt.run(JSON.stringify(updatedDecision), item.id);
            }
          }
        } catch {
          // ignore corrupted unparseable JSON
        }
      }

      db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('sourcing_decision_repair_version', '1')");
      db.exec("UPDATE app_meta SET value = '1' WHERE key = 'sourcing_decision_repair_version'");
    })();
    console.log('[Migrations] Sourcing decision repair migration complete.');
  }

  // ── Packaging-OCR shadow comparisons (packaging-ocr overhaul plan P2-T4) ────
  //
  // Additive dual-run diagnostics table: one row per (item, run) where the new
  // `packaging_ocr` classification stage executed alongside the legacy inline
  // OCR path. Purely observational — no authority decision reads these rows.
  // Idempotent via CREATE TABLE/INDEX IF NOT EXISTS (fresh installs and every
  // existing database get the table on the next migration pass).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS packaging_ocr_shadow_comparisons (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
        batch_id TEXT,
        run_id TEXT,
        legacy_status TEXT,
        legacy_reason TEXT,
        stage_status TEXT NOT NULL,
        stage_reason TEXT,
        field_agreement_json TEXT,
        created_at TEXT NOT NULL
      );
    `);
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_packaging_ocr_shadow_item ON packaging_ocr_shadow_comparisons(item_id);',
    );
  } catch (e) {
    console.error('Failed to create packaging_ocr_shadow_comparisons table:', e);
  }

  // ── Variant resolution durable table (issue #90) ───────────────────────
  try {
    const variantResVersion = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('onboarding_variant_resolution_schema_version') as { value: string } | undefined;
    if (!variantResVersion) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS onboarding_variant_resolutions (
          id TEXT PRIMARY KEY,
          onboarding_item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
          source_url TEXT NOT NULL,
          canonical_parent_key TEXT NOT NULL,
          platform TEXT NOT NULL,
          parser_version INTEGER NOT NULL,
          identity_matrix_hash TEXT NOT NULL,
          source_content_hash TEXT,
          status TEXT NOT NULL CHECK(status IN ('resolved','ambiguous','no_match','unsupported','too_many_variants','selected','stale')),
          reason_codes_json TEXT NOT NULL,
          candidates_json TEXT NOT NULL,
          automatic_variant_key TEXT,
          selected_variant_key TEXT,
          decision_origin TEXT CHECK(decision_origin IN ('automatic','operator')),
          decided_at TEXT,
          superseded_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_variant_res_item ON onboarding_variant_resolutions(onboarding_item_id);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_variant_res_item_hash ON onboarding_variant_resolutions(onboarding_item_id, identity_matrix_hash);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_variant_res_status ON onboarding_variant_resolutions(status);');
      db.exec("INSERT INTO app_meta (key, value) VALUES ('onboarding_variant_resolution_schema_version', '1');");
      console.log('[Migrations] Variant resolution table created.');
    }
  } catch (e) {
    console.error('[Migrations] Failed to create variant resolution table:', e);
  }

  // ── ADR-0030 Phase 4: Agent Lab data retirement ────────────────────────
  // Drops every PI-only table after the Agent Lab runtime deletion (Phase 3).
  // KEPT: product_intelligence_assets (live-written by onboarding distributor
  // imagery), pi_reuse_policies (live reuse grants), benchmark_* (shared with
  // the classification program, ADR #14). Historical JSON dumps live in the
  // gitignored archive/pi-decommission-20260824/ directory.
  try {
    const decommissionVersion = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('decommission_pi_schema_version') as { value: string } | undefined;
    if (!decommissionVersion) {
      console.log('[Migrations] Running ADR-0030 Phase 4 PI data retirement migration...');
      db.transaction(() => {
        const countAssets = () =>
          (db.query('SELECT COUNT(*) AS n FROM product_intelligence_assets').get() as { n: number }).n;
        const before = countAssets();

        // Step 1: rebuild product_intelligence_assets WITHOUT the run_id FK
        // (ON DELETE CASCADE toward product_intelligence_runs would otherwise
        // wipe every asset row when runs is dropped) and WITHOUT the
        // source_id FK (sources is dropped too). The onboarding_item_id FK is
        // preserved. Column set mirrors the live table exactly.
        db.exec('DROP TRIGGER IF EXISTS trg_pi_asset_candidate_same_run;');
        db.exec(`
          CREATE TABLE product_intelligence_assets_new (
            id TEXT PRIMARY KEY,
            run_id TEXT,
            source_id TEXT,
            source_url TEXT NOT NULL,
            source_page_url TEXT,
            source_type TEXT NOT NULL,
            source_path TEXT,
            source_artifact_id TEXT,
            extraction_method TEXT NOT NULL CHECK (extraction_method IN ('json_ld', 'platform_api', 'network_response', 'profile_selector', 'media_api', 'manual', 'image_ocr', 'decoder')),
            retrieved_at TEXT NOT NULL,
            original_content_hash TEXT NOT NULL,
            perceptual_hash TEXT,
            variant_reference TEXT,
            rights_status TEXT NOT NULL CHECK (rights_status IN ('approved', 'restricted', 'unknown')),
            rights_basis TEXT,
            rights_evidence_ref TEXT,
            observed_brand TEXT,
            observed_product_name TEXT,
            observed_variant TEXT,
            observed_net_content_json TEXT,
            observed_pack_count INTEGER,
            observed_gtin TEXT,
            exact_product_match INTEGER NOT NULL DEFAULT 0,
            exact_variant_match INTEGER,
            quality_status TEXT NOT NULL CHECK (quality_status IN ('usable', 'low_quality', 'invalid')),
            commerce_approved INTEGER NOT NULL DEFAULT 0,
            conflicts_json TEXT NOT NULL DEFAULT '[]',
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            verified_against_json TEXT,
            verified_against_hash TEXT,
            declared_source_type TEXT,
            candidate_id TEXT,
            brand_evidence_id TEXT,
            brand_evidence_hash TEXT,
            origin TEXT NOT NULL DEFAULT 'pi_run',
            onboarding_item_id TEXT REFERENCES onboarding_items(id) ON DELETE CASCADE
          );`);
        db.exec(`
          INSERT INTO product_intelligence_assets_new SELECT * FROM product_intelligence_assets;`);
        db.exec('DROP TABLE product_intelligence_assets;');
        db.exec('ALTER TABLE product_intelligence_assets_new RENAME TO product_intelligence_assets;');
        db.exec('CREATE INDEX IF NOT EXISTS idx_pi_assets_onboarding_item ON product_intelligence_assets(onboarding_item_id);');
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pi_assets_onboarding_url
            ON product_intelligence_assets(onboarding_item_id, source_url)
            WHERE origin = 'onboarding_distributor' AND onboarding_item_id IS NOT NULL;`);
        const after = countAssets();
        if (after !== before) {
          throw new Error(`product_intelligence_assets row-count mismatch after rebuild: before=${before} after=${after}`);
        }
        console.log(`[Migrations] product_intelligence_assets rebuilt without PI FKs (${after} rows preserved).`);

        // Step 2: drop the PI-only family, children before parents. With
        // foreign_keys disabled during the transaction this order is a
        // formality, but it keeps manual/foreign_keys-ON recoveries sane.
        const piDropOrder = [
          'product_intelligence_imports',
          'agent_evaluation_cases',
          'agent_evaluation_snapshots',
          'agent_teaching_events',
          'agent_corrections',
          'agent_version_states',
          'agent_version_snapshots',
          'pi_image_candidates',
          'pi_source_authorities',
          'pi_page_artifacts',
          'product_intelligence_tool_calls',
          'product_intelligence_steps',
          'product_intelligence_events',
          'product_intelligence_policy_decisions',
          'product_intelligence_comparisons',
          'product_intelligence_conflicts',
          'product_intelligence_evidence',
          'product_intelligence_results',
          'pi_review_decisions',
          'product_intelligence_sources',
          'pi_approved_policies',
          'pi_budget_policies',
          'pi_retention_policies',
          'pi_evaluation_runs',
          'product_intelligence_runs',
        ];
        for (const t of piDropOrder) {
          db.exec(`DROP TABLE IF EXISTS ${t};`);
        }

        // Step 3: app_meta bookkeeping. NOTE: we deliberately KEEP the
        // historical *_schema_version guard keys (product_intelligence_*,
        // pi_*): the migration blocks they guard still exist above in this
        // file, and deleting their keys would cause those blocks to RE-RUN on
        // the next startup against the now-dropped tables and crash. They are
        // inert markers for already-applied code paths.
        db.exec("INSERT INTO app_meta (key, value) VALUES ('decommission_pi_schema_version', '1');");
      })();

      const violations = db.query("PRAGMA foreign_key_check('product_intelligence_assets')").all();
      if (violations.length > 0) {
        console.warn(`[Migrations] ${violations.length} FK violations in kept product_intelligence_assets post-retirement:`, violations.slice(0, 5));
      }
      console.log('[Migrations] ADR-0030 Phase 4 PI data retirement complete.');
    }
  } catch (e) {
    console.error('[Migrations] ADR-0030 Phase 4 PI data retirement failed:', e);
    throw e;
  }

  // ── Proposal Derivation Provenance Column (Curation Refinement) ───────────────
  try {
    const derivationVersion = db.query('SELECT value FROM app_meta WHERE key = ?').get('proposal_derivation_schema_version') as
      | { value: string }
      | undefined;
    if (!derivationVersion) {
      console.log('[Migrations] Running proposal derivation schema migration...');
      const proposalCols = db.query('PRAGMA table_info(classification_proposals)').all() as Array<{ name: string }>;
      if (!proposalCols.some(c => c.name === 'derivation_json')) {
        db.exec('ALTER TABLE classification_proposals ADD COLUMN derivation_json TEXT;');
      }
      db.exec("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('proposal_derivation_schema_version', '1');");
      console.log('[Migrations] Proposal derivation schema migration complete.');
    }
  } catch (e) {
    console.error('[Migrations] Proposal derivation schema migration failed:', e);
    throw e;
  }

  // ── Milestone 4 (P1-D): Operation receipts for idempotent approval/export ──
  try {
    const receiptVersion = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('onboarding_operation_receipt_schema_version') as { value: string } | undefined;
    if (!receiptVersion) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS onboarding_operation_receipts (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          batch_id TEXT NOT NULL REFERENCES onboarding_batches(id) ON DELETE CASCADE,
          operation TEXT NOT NULL CHECK(operation IN ('approve','export')),
          principal TEXT NOT NULL,
          role TEXT NOT NULL,
          created_at TEXT NOT NULL,
          idempotency_key TEXT,
          request_hash TEXT NOT NULL CHECK(request_hash GLOB '[0-9a-f]*' AND length(request_hash) = 64),
          details_json TEXT,
          status TEXT NOT NULL CHECK(status IN ('started','completed','failed')) DEFAULT 'completed',
          started_at TEXT,
          completed_at TEXT,
          UNIQUE(workspace_id, batch_id, operation, idempotency_key)
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_operation_receipts_batch ON onboarding_operation_receipts(batch_id);');
      db.exec('CREATE INDEX IF NOT EXISTS idx_operation_receipts_workspace ON onboarding_operation_receipts(workspace_id);');
      db.exec("INSERT INTO app_meta (key, value) VALUES ('onboarding_operation_receipt_schema_version', '2');");
      console.log('[Migrations] Operation receipts table created (v2).');
    } else if (receiptVersion.value === '1') {
      console.log('[Migrations] Migrating operation receipts v1 -> v2 (composite key + request_hash)...');
      const cols = db.query('PRAGMA table_info(onboarding_operation_receipts)').all() as Array<{ name: string }>;
      const hasRequestHash = cols.some(c => c.name === 'request_hash');
      if (!hasRequestHash) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS onboarding_operation_receipts_new (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
            batch_id TEXT NOT NULL REFERENCES onboarding_batches(id) ON DELETE CASCADE,
            operation TEXT NOT NULL CHECK(operation IN ('approve','export')),
            principal TEXT NOT NULL,
            role TEXT NOT NULL,
            created_at TEXT NOT NULL,
            idempotency_key TEXT,
            request_hash TEXT NOT NULL CHECK(request_hash GLOB '[0-9a-f]*' AND length(request_hash) = 64),
            details_json TEXT,
            UNIQUE(workspace_id, batch_id, operation, idempotency_key)
          );
        `);
        // Legacy v1 rows had empty request_hash; backfill with canonical hash of empty array (64 hex) to satisfy new CHECK
        const emptyHash = require('node:crypto').createHash('sha256').update(JSON.stringify([]), 'utf8').digest('hex');
        db.exec(`
          INSERT OR IGNORE INTO onboarding_operation_receipts_new (id, workspace_id, batch_id, operation, principal, role, created_at, idempotency_key, request_hash, details_json)
          SELECT id, workspace_id, batch_id, operation, principal, role, created_at, idempotency_key, CASE WHEN request_hash = '' OR request_hash IS NULL THEN '${emptyHash}' ELSE request_hash END, details_json FROM onboarding_operation_receipts;
        `);
        db.exec('DROP TABLE onboarding_operation_receipts;');
        db.exec('ALTER TABLE onboarding_operation_receipts_new RENAME TO onboarding_operation_receipts;');
        db.exec('CREATE INDEX IF NOT EXISTS idx_operation_receipts_batch ON onboarding_operation_receipts(batch_id);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_operation_receipts_workspace ON onboarding_operation_receipts(workspace_id);');
      }
      db.exec("UPDATE app_meta SET value = '2' WHERE key = 'onboarding_operation_receipt_schema_version';");
      console.log('[Migrations] Operation receipts migrated to v2.');
    }
    // v2 -> v3: add lifecycle status columns (started, completed, failed) + timestamps
    const receiptV2b = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('onboarding_operation_receipt_schema_version') as { value: string } | undefined;
    if (receiptV2b && receiptV2b.value === '2') {
      console.log('[Migrations] Migrating operation receipts v2 -> v3 (status lifecycle)...');
      const rCols = db.query('PRAGMA table_info(onboarding_operation_receipts)').all() as Array<{ name: string }>;
      if (!rCols.some(c => c.name === 'status')) {
        db.exec("ALTER TABLE onboarding_operation_receipts ADD COLUMN status TEXT NOT NULL CHECK(status IN ('started','completed','failed')) DEFAULT 'completed';");
      }
      if (!rCols.some(c => c.name === 'started_at')) {
        db.exec('ALTER TABLE onboarding_operation_receipts ADD COLUMN started_at TEXT;');
      }
      if (!rCols.some(c => c.name === 'completed_at')) {
        db.exec('ALTER TABLE onboarding_operation_receipts ADD COLUMN completed_at TEXT;');
      }
      // Backfill existing rows to completed if details_json present, else started
      try { db.exec("UPDATE onboarding_operation_receipts SET status = 'completed', completed_at = COALESCE(completed_at, created_at) WHERE details_json IS NOT NULL AND status = 'completed';"); } catch {}
      try { db.exec("UPDATE onboarding_operation_receipts SET status = 'started', started_at = COALESCE(started_at, created_at) WHERE details_json IS NULL;"); } catch {}
      db.exec("UPDATE app_meta SET value = '3' WHERE key = 'onboarding_operation_receipt_schema_version';");
      console.log('[Migrations] Operation receipts migrated to v3.');
    }
    // v3 -> v4: enforce 64-hex request_hash (remove empty default, add CHECK)
    const receiptV3b = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('onboarding_operation_receipt_schema_version') as { value: string } | undefined;
    if (receiptV3b && receiptV3b.value === '3') {
      console.log('[Migrations] Migrating operation receipts v3 -> v4 (64-hex request_hash)...');
      try {
        const emptyHash = require('node:crypto').createHash('sha256').update(JSON.stringify([]), 'utf8').digest('hex');
        db.exec(`UPDATE onboarding_operation_receipts SET request_hash = '${emptyHash}' WHERE request_hash = '' OR length(request_hash) != 64 OR request_hash GLOB '*[^0-9a-f]*'`);
      } catch (e) {
        console.warn('[Migrations] Failed to backfill empty request_hash (non-fatal):', e);
      }
      // SQLite cannot ADD CHECK via ALTER; fresh DBs already have CHECK from v2 creation. For existing DBs, rely on repository Zod validation (64-hex) as the boundary.
      db.exec("UPDATE app_meta SET value = '4' WHERE key = 'onboarding_operation_receipt_schema_version';");
      console.log('[Migrations] Operation receipts migrated to v4 (64-hex).');
    }
    // v4 -> v5 (ticket #124): widen the operation CHECK to gap-correction
    // commands. SQLite cannot ALTER a CHECK: rebuild preserves every row
    // and column (status lifecycle included), exactly one version bump.
    const receiptV4b = db
      .query('SELECT value FROM app_meta WHERE key = ?')
      .get('onboarding_operation_receipt_schema_version') as { value: string } | undefined;
    if (receiptV4b && receiptV4b.value === '4') {
      console.log('[Migrations] Migrating operation receipts v4 -> v5 (gap_correction operation)...');
      db.transaction(() => {
        // Ticket #124 P2-8: a crashed prior run must never leave a stale
        // _new table behind (old CHECK) nor silently skip rows — drop
        // first and insert loudly inside the transaction.
        db.exec('DROP TABLE IF EXISTS onboarding_operation_receipts_new;');
        db.exec(`
          CREATE TABLE onboarding_operation_receipts_new (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
            batch_id TEXT NOT NULL REFERENCES onboarding_batches(id) ON DELETE CASCADE,
            operation TEXT NOT NULL CHECK(operation IN ('approve','export','gap_correction')),
            principal TEXT NOT NULL,
            role TEXT NOT NULL,
            created_at TEXT NOT NULL,
            idempotency_key TEXT,
            request_hash TEXT NOT NULL CHECK(request_hash GLOB '[0-9a-f]*' AND length(request_hash) = 64),
            details_json TEXT,
            status TEXT NOT NULL CHECK(status IN ('started','completed','failed')) DEFAULT 'completed',
            started_at TEXT,
            completed_at TEXT,
            UNIQUE(workspace_id, batch_id, operation, idempotency_key)
          );
        `);
        db.exec(`
          INSERT INTO onboarding_operation_receipts_new
            (id, workspace_id, batch_id, operation, principal, role, created_at, idempotency_key, request_hash, details_json, status, started_at, completed_at)
          SELECT id, workspace_id, batch_id, operation, principal, role, created_at, idempotency_key, request_hash, details_json, status, started_at, completed_at
          FROM onboarding_operation_receipts;
        `);
        db.exec('DROP TABLE onboarding_operation_receipts;');
        db.exec('ALTER TABLE onboarding_operation_receipts_new RENAME TO onboarding_operation_receipts;');
        db.exec('CREATE INDEX IF NOT EXISTS idx_operation_receipts_batch ON onboarding_operation_receipts(batch_id);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_operation_receipts_workspace ON onboarding_operation_receipts(workspace_id);');
      })();
      db.exec("UPDATE app_meta SET value = '5' WHERE key = 'onboarding_operation_receipt_schema_version';");
      console.log('[Migrations] Operation receipts migrated to v5.');
    }
  } catch (e) {
    console.error('[Migrations] Failed to create operation receipts table:', e);
  }

  // ── Milestone 5 (P1-B): Lossless imported identity ──────────────────────
  // Atomic, guarded, truthful legacy backfill — per hardening plan 350-354
  const identityVersion = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get('imported_identity_schema_version') as { value: string } | undefined;
  if (!identityVersion) {
    console.log('[Migrations] Running imported identity schema migration (atomic, guarded)...');
    try {
      db.transaction(() => {
        // Guard INSIDE same transaction: refuse if active cohort runs exist; only swallow exact "no such table" else rethrow
        try {
          const row = db.query("SELECT COUNT(*) as c FROM classification_cohort_runs WHERE status IN ('freezing','running')").get() as { c: number } | undefined;
          const activeRuns = row?.c ?? 0;
          if (activeRuns > 0) {
            console.error(`[Migrations] Refusing imported-identity migration: ${activeRuns} active cohort runs (freezing|running) — pause worker and retry.`);
            throw new Error(`Imported-identity migration refused: ${activeRuns} active cohort runs`);
          }
        } catch (e: any) {
          if (e && typeof e.message === 'string' && e.message.includes('no such table: classification_cohort_runs')) {
            // Fresh DB — no cohort runs table yet, treat as 0
          } else {
            throw e;
          }
        }
        const cols = db.query('PRAGMA table_info(onboarding_items)').all() as Array<{ name: string }>;
        const colNames = new Set(cols.map(c => c.name));
        if (!colNames.has('raw_identity_json')) {
          db.exec('ALTER TABLE onboarding_items ADD COLUMN raw_identity_json TEXT;');
        }
        if (!colNames.has('normalized_identity_json')) {
          db.exec('ALTER TABLE onboarding_items ADD COLUMN normalized_identity_json TEXT;');
        }
        if (!colNames.has('identity_normalizer_version')) {
          db.exec('ALTER TABLE onboarding_items ADD COLUMN identity_normalizer_version INTEGER;');
        }
        if (!colNames.has('identity_provenance_hash')) {
          db.exec('ALTER TABLE onboarding_items ADD COLUMN identity_provenance_hash TEXT;');
        }
        // Backfill legacy rows as lossy truthful envelope: preserve every operational field, raw NULL, version 0, lossy=true
        const legacyRows = db.query("SELECT id, upc, name, price, quantity, brand_hint, department_hint, source_url, row_number FROM onboarding_items WHERE normalized_identity_json IS NULL AND name IS NOT NULL").all() as Array<{ id: string; upc: string; name: string; price: string | null; quantity: number | null; brand_hint: string | null; department_hint: string | null; source_url: string | null; row_number: number }>;
        // Use canonical provenance: hash of canonical raw (null) + normalized envelope + source
        const { canonicalJsonStringify } = require('../shared/stable-id');
        const updateStmt = db.query('UPDATE onboarding_items SET normalized_identity_json = ?, raw_identity_json = NULL, identity_normalizer_version = 0, identity_provenance_hash = ? WHERE id = ?');
        for (const r of legacyRows) {
          const normalizedEnvelope = {
            version: 0,
            upc: (r as any).upc ?? '',
            name: r.name,
            brandHint: r.brand_hint ?? null,
            departmentHint: (r as any).department_hint ?? null,
            price: (r as any).price ?? null,
            quantity: (r as any).quantity !== null && (r as any).quantity !== undefined ? String((r as any).quantity) : null,
            sourceUrl: (r as any).source_url ?? null,
            rowNumber: r.row_number ?? 1,
            mappingHash: require('node:crypto').createHash('sha256').update('legacy', 'utf8').digest('hex'),
            transformations: [],
            parserProvenance: { source: 'legacy_operational_backfill', parserVersion: 0 },
          };
          const normalizedJson = canonicalJsonStringify(normalizedEnvelope);
          // Truthful legacy provenanceHash: hash(version0 + normalized + legacy_operational_backfill + lossy)
          const { computeLegacyProvenanceHash } = require('../onboarding/imported-identity');
          const hash = computeLegacyProvenanceHash(normalizedJson);
          updateStmt.run(normalizedJson, hash, r.id);
        }
        console.log(`[Migrations] Backfilled ${legacyRows.length} legacy imported identities (lossy, truthful).`);
        db.exec("INSERT INTO app_meta (key, value) VALUES ('imported_identity_schema_version', '1');");
      })();
      console.log('[Migrations] Imported identity schema migration complete (v1, atomic).');
    } catch (e) {
      console.error('[Migrations] Imported identity schema migration failed (atomic rollback, marker NOT written):', e);
      throw e;
    }
  }

  // ── Manual-evidence foundation (parent #101, ticket #102) ───────────────
  // Additive only, marker-gated, no backfill: attestation table + nullable
  // reference columns. No behavior change — no writer exists yet, so the
  // verification queries below must find zero manual-method rows on first
  // run and refuse boot only on genuine invariant violations.
  const manualEvidenceVersion = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get('manual_evidence_schema_version') as { value: string } | undefined;
  if (!manualEvidenceVersion) {
    console.log('[Migrations] Running manual-evidence foundation migration (additive, v1)...');
    db.transaction(() => {
      db.exec('PRAGMA defer_foreign_keys = ON');
      db.exec(`
        CREATE TABLE IF NOT EXISTS onboarding_manual_evidence_attestations (
          attestation_id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL REFERENCES onboarding_items(id) ON DELETE CASCADE,
          batch_id TEXT,
          operator_id TEXT NOT NULL,
          attested_at TEXT NOT NULL,
          family_reference_url TEXT,
          field_checklist_json TEXT NOT NULL,
          value_hashes_json TEXT NOT NULL,
          superseded_at TEXT,
          created_at TEXT NOT NULL
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_manual_evidence_attestations_item ON onboarding_manual_evidence_attestations(item_id);');
      const extCols = db.query('PRAGMA table_info(onboarding_extractions)').all() as Array<{ name: string }>;
      if (!extCols.some((c) => c.name === 'manual_attestation_id')) {
        db.exec('ALTER TABLE onboarding_extractions ADD COLUMN manual_attestation_id TEXT;');
      }
      const itemCols = db.query('PRAGMA table_info(onboarding_items)').all() as Array<{ name: string }>;
      if (!itemCols.some((c) => c.name === 'manual_reference_url')) {
        db.exec('ALTER TABLE onboarding_items ADD COLUMN manual_reference_url TEXT;');
      }
      // Verification (fail boot on violation, never silently repair).
      // Extracted to verifyManualEvidenceInvariants (ticket #105) so the
      // hardening suite can pin each violation class on fixtures.
      verifyManualEvidenceInvariants(db);
      db.exec("INSERT INTO app_meta (key, value) VALUES ('manual_evidence_schema_version', '1');");
    })();
    console.log('[Migrations] Manual-evidence foundation migration complete (v1, additive).');
  }

  // Parent #101 (manual-evidence route, ticket #104 full set): v2 adds two
  // nullable attestation columns — per-image rights approvals JSON and the
  // operator-pasted family-reference text snapshot (inheritance guard).
  // Additive only: existing rows read NULL (no approvals, no snapshot).
  const manualEvidenceV2Version = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get('manual_evidence_schema_version') as { value: string } | undefined;
  if (manualEvidenceV2Version && manualEvidenceV2Version.value === '1') {
    console.log('[Migrations] Running manual-evidence full-set migration (additive, v2)...');
    db.transaction(() => {
      const attCols = db.query('PRAGMA table_info(onboarding_manual_evidence_attestations)').all() as Array<{ name: string }>;
      if (!attCols.some((c) => c.name === 'image_rights_json')) {
        db.exec('ALTER TABLE onboarding_manual_evidence_attestations ADD COLUMN image_rights_json TEXT;');
      }
      if (!attCols.some((c) => c.name === 'family_reference_text')) {
        db.exec('ALTER TABLE onboarding_manual_evidence_attestations ADD COLUMN family_reference_text TEXT;');
      }
      // Verification (fail boot on violation, never silently repair): the
      // shared verifier covers classes 1–4 now that the v2 columns exist.
      verifyManualEvidenceInvariants(db);
      db.exec("UPDATE app_meta SET value = '2' WHERE key = 'manual_evidence_schema_version';");
    })();
    console.log('[Migrations] Manual-evidence full-set migration complete (v2, additive).');
  }

  // Issue #150 (Amendment B1.1): retire brand advisory settings. Runs
  // AFTER every historical advisory dependency above (distributor-v2 table
  // creation, batch-preflight advisory ALTER). Fresh databases create the
  // legacy schema in those historical steps and retire it here before
  // startup completes; old markers are never reinterpreted. Any failure
  // aborts startup/transaction — never a logged-and-swallowed success.
  // A retired table that unexpectedly reappears with a completed marker
  // fails verification instead of being silently used or deleted.
  const brandAdvisoryRetirementVersion = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get('brand_advisory_retirement_schema_version') as { value: string } | undefined;
  if (!brandAdvisoryRetirementVersion) {
    db.transaction(() => {
      const snapDef = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sourcing_generation_strategy_snapshots'").get() as
        | { sql: string | null }
        | undefined;
      if (snapDef?.sql && !snapDef.sql.includes('query_all')) {
        const retirementSql = fs.readFileSync(BRAND_ADVISORY_RETIREMENT_MIGRATION_PATH, 'utf-8');
        db.exec(retirementSql);
      } else if (snapDef?.sql) {
        // Snapshots already final (e.g. defensive DDL created it): drop the
        // advisory table without touching snapshot rows.
        db.exec('DROP TABLE IF EXISTS brand_advisory_profiles');
      }
      // Validate the final schema before writing the marker.
      const advisoryLeft = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'brand_advisory_profiles'").get() as
        | { name: string }
        | undefined;
      if (advisoryLeft) {
        throw new Error('[Migrations] brand advisory retirement failed: brand_advisory_profiles still exists');
      }
      const finalSnap = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sourcing_generation_strategy_snapshots'").get() as
        | { sql: string | null }
        | undefined;
      if (!finalSnap?.sql || !finalSnap.sql.includes('query_all') || !finalSnap.sql.includes('strategy-binding-v2')) {
        throw new Error('[Migrations] brand advisory retirement failed: strategy snapshot table is not at the retired schema');
      }
      const retireFk = db.query('PRAGMA foreign_key_check').all() as Array<{ table: string }>;
      if (retireFk.length > 0) {
        throw new Error(`[Migrations] brand advisory retirement foreign_key_check failed: ${JSON.stringify(retireFk.slice(0, 5))}`);
      }
      db.exec("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('brand_advisory_retirement_schema_version', '1');");
    })();
    console.log('[Migrations] Brand advisory retirement migration complete.');
  } else {
    // Rerun with the final marker verifies schema and writes no rows.
    const advisoryResurrected = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'brand_advisory_profiles'").get() as
      | { name: string }
      | undefined;
    if (advisoryResurrected) {
      throw new Error('[Migrations] brand_advisory_profiles reappeared after retirement — refusing boot (restore the verified pre-upgrade backup; never auto-delete unexpected data)');
    }
    const snapCheck = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sourcing_generation_strategy_snapshots'").get() as
      | { sql: string | null }
      | undefined;
    if (!snapCheck?.sql || !snapCheck.sql.includes('query_all')) {
      throw new Error('[Migrations] sourcing_generation_strategy_snapshots lost its retired schema — refusing boot');
    }
  }

  // Ticket #105 (review P1-1): enforce the manual-evidence invariants on
  // every boot once the foundation migration has applied — not only on the
  // first migration. Fail boot on violation, never silently repair.
  const manualEvidenceApplied = db
    .query('SELECT value FROM app_meta WHERE key = ?')
    .get('manual_evidence_schema_version') as { value: string } | undefined;
  if (manualEvidenceApplied) {
    verifyManualEvidenceInvariants(db);
  }

  const row = db.query('SELECT value FROM app_meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  if (!row) {
    throw new Error('Schema migration did not create app_meta');
  }

  // Slice 5a (council plan §5.1/§5.3): stage-vocabulary precondition/order
  // validation ONLY — never an unconditional live startup backfill. The
  // rename backfill runs exclusively through the offline maintenance script
  // (`scripts/onboarding-stage-vocabulary.ts --mode=apply`) under quiescence
  // with a verified backup. Here we only: (a) refuse boot on an unknown
  // storage version, (b) refuse boot on unknown stage literals when storage
  // claims v2 (fail closed, never coerce), (c) leave v1/absent untouched.
  const vocabRow = db.query('SELECT value FROM app_meta WHERE key = ?').get('onboarding_stage_vocabulary_version') as
    | { value: string }
    | undefined;
  if (vocabRow && vocabRow.value !== '1' && vocabRow.value !== '2') {
    throw new Error(`[Migrations] Unknown ${'onboarding_stage_vocabulary_version'}=${vocabRow.value} — refusing boot (no VITE_* override)`);
  }
  if (vocabRow?.value === '2') {
    const bad = db.query(
      `SELECT COUNT(*) AS cnt FROM onboarding_items WHERE stage IS NULL OR stage NOT IN
       ('route_sources','find_product_page','collect_details','prepare_listing','review_listings','create_drafts',
        'sourcing','discovery','extraction','curation','review','promotion')`,
    ).get() as { cnt: number };
    if (bad.cnt > 0) {
      throw new Error(
        `[Migrations] Refusing boot: ${bad.cnt} onboarding_items row(s) carry unknown/null stage literals ` +
          `while onboarding_stage_vocabulary_version=2 — fail closed (no coercion to the first stage)`,
      );
    }
  }
}

export function getSchemaVersion(): string {
  const db = getDb();
  const row = db.query('SELECT value FROM app_meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  return row?.value ?? '0';
}
