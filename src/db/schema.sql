-- Bay State CMS SQLite Schema
-- SQLite is not canonical catalog storage. It is local operational state:
-- setup, indexing, drafts, validation, sync jobs, logs, and drift.

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  git_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  bootstrap_status TEXT NOT NULL DEFAULT 'not_started',
  baseline_commit TEXT
);

CREATE TABLE IF NOT EXISTS connection (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  cgi_base_url TEXT NOT NULL,
  auth_strategy TEXT NOT NULL DEFAULT 'basic',
  merchant_id TEXT,
  password_secret_ref TEXT,
  last_tested_at TEXT,
  last_test_status TEXT,
  last_test_error TEXT
);

CREATE TABLE IF NOT EXISTS product_index (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  file_path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  price TEXT,
  inventory_quantity INTEGER,
  primary_image TEXT,
  product_hash TEXT NOT NULL,
  last_approved_commit TEXT,
  last_pulled_remote_hash TEXT,
  last_synced_remote_hash TEXT,
  last_synced_at TEXT,
  sync_status TEXT NOT NULL DEFAULT 'not_synced',
  has_advanced_blocks INTEGER NOT NULL DEFAULT 0,
  has_warnings INTEGER NOT NULL DEFAULT 0,
  parent_sku TEXT REFERENCES product_index(sku),
  description TEXT,
  search_keywords TEXT,
  custom_fields TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ── ARCHIVED (Gen1, P5 retirement 2026-08-24) ──────────────────────────────
-- `product_types` + `product_type_fields` are the pre-classification legacy
-- field-map tables (superseded by the immutable taxonomy releases under
-- src/classification/releases/). RETAINED READ-ONLY for history and as the
-- sole source of the candidate-only legacy migration bridge
-- (src/classification/legacy-migration.ts -> POST /api/classification/migrate-legacy).
-- No production code reads or writes them outside that bridge; no routes serve
-- them; destructive DROP is intentionally deferred pending owner decision.
CREATE TABLE IF NOT EXISTS product_types (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- See archive banner above `product_types` — same Gen1 status.
CREATE TABLE IF NOT EXISTS product_type_fields (
  id TEXT PRIMARY KEY,
  product_type_id TEXT NOT NULL REFERENCES product_types(id),
  xml_field TEXT NOT NULL,
  label TEXT NOT NULL,
  data_type TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 0,
  validation_rules_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(product_type_id, xml_field)
);

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

CREATE TABLE IF NOT EXISTS page_index (
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
);

CREATE INDEX IF NOT EXISTS idx_page_index_name ON page_index(name);
-- idx_page_index_identity, idx_page_index_import, and
-- idx_page_index_identity_unique are created by the page identity migration
-- AFTER the workspace/import/identity columns exist (an old-shape table would
-- break index creation at schema.sql load).

CREATE TABLE IF NOT EXISTS product_pages (
  product_sku TEXT NOT NULL,
  page_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (product_sku, page_name)
);

CREATE TABLE IF NOT EXISTS field_registry (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  xml_field TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'custom',
  data_type TEXT NOT NULL DEFAULT 'string',
  editable INTEGER NOT NULL DEFAULT 1,
  required INTEGER NOT NULL DEFAULT 0,
  ui_group TEXT,
  sample_values_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, xml_field)
);

CREATE TABLE IF NOT EXISTS change_sets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  base_commit TEXT NOT NULL,
  approved_commit TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT
);

CREATE TABLE IF NOT EXISTS change_set_items (
  id TEXT PRIMARY KEY,
  change_set_id TEXT NOT NULL REFERENCES change_sets(id),
  sku TEXT NOT NULL,
  operation TEXT NOT NULL DEFAULT 'update',
  draft_json TEXT NOT NULL,
  base_json TEXT,
  draft_hash TEXT NOT NULL,
  validation_status TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(change_set_id, sku)
);

CREATE TABLE IF NOT EXISTS validation_results (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  field_path TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  change_set_id TEXT REFERENCES change_sets(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  started_at TEXT,
  completed_at TEXT,
  product_count INTEGER DEFAULT 0,
  artifact_path TEXT,
  error_summary TEXT,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS sync_job_events (
  id TEXT PRIMARY KEY,
  sync_job_id TEXT NOT NULL REFERENCES sync_jobs(id),
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_drift (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  sku TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  local_hash TEXT,
  remote_hash TEXT NOT NULL,
  local_json TEXT,
  remote_json TEXT NOT NULL,
  diff_json TEXT,
  reconcile_change_set_id TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL
);

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

CREATE INDEX IF NOT EXISTS idx_product_index_sku ON product_index(sku);
CREATE INDEX IF NOT EXISTS idx_product_index_status ON product_index(status);
CREATE INDEX IF NOT EXISTS idx_product_index_title ON product_index(title);
CREATE INDEX IF NOT EXISTS idx_change_set_items_change_set ON change_set_items(change_set_id);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_workspace ON sync_jobs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_remote_drift_workspace ON remote_drift(workspace_id);
CREATE INDEX IF NOT EXISTS idx_remote_drift_ws_sku_status ON remote_drift(workspace_id, sku, status);
CREATE INDEX IF NOT EXISTS idx_remote_drift_sku ON remote_drift(sku);
CREATE INDEX IF NOT EXISTS idx_audit_log_workspace ON audit_log(workspace_id);
CREATE INDEX IF NOT EXISTS idx_catalog_health_proposals_ws ON catalog_health_proposals(workspace_id);
CREATE INDEX IF NOT EXISTS idx_catalog_health_proposals_status ON catalog_health_proposals(status);

-- ─── Benchmark / Evaluation (frozen Gold + prediction bundles) ────────────────

CREATE TABLE IF NOT EXISTS benchmark_datasets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  name TEXT NOT NULL,
  holdout_strategy TEXT NOT NULL DEFAULT 'product_family',
  split_seed INTEGER NOT NULL,
  total_examples INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'frozen', 'retired')),
  family_review_complete INTEGER NOT NULL DEFAULT 0,
  family_reviewed_by TEXT,
  family_reviewed_at TEXT,
  dataset_hash TEXT,
  frozen_at TEXT,
  frozen_by TEXT,
  retired_at TEXT,
  source_config_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS benchmark_examples (
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

CREATE TABLE IF NOT EXISTS benchmark_eval_runs (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES benchmark_datasets(id) ON DELETE CASCADE,
  run_label TEXT NOT NULL,
  model_config_json TEXT,
  prediction_bundle_id TEXT,
  metrics_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

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

CREATE INDEX IF NOT EXISTS idx_benchmark_datasets_workspace ON benchmark_datasets(workspace_id);
CREATE INDEX IF NOT EXISTS idx_benchmark_examples_dataset ON benchmark_examples(dataset_id);
CREATE INDEX IF NOT EXISTS idx_benchmark_examples_split ON benchmark_examples(dataset_id, split_group);
CREATE INDEX IF NOT EXISTS idx_benchmark_prediction_bundles_dataset ON benchmark_prediction_bundles(dataset_id);
CREATE INDEX IF NOT EXISTS idx_benchmark_eval_runs_dataset ON benchmark_eval_runs(dataset_id);
CREATE INDEX IF NOT EXISTS idx_benchmark_qualification_receipts_dataset ON benchmark_qualification_receipts(dataset_id);
CREATE INDEX IF NOT EXISTS idx_benchmark_qualification_receipts_digest ON benchmark_qualification_receipts(digest);

-- ─── Classification model-call provenance (issue #17 E) ────────────────────
-- Durable per-call observability for protected model calls bound to a
-- classification run. classification_runs is created by
-- classification-migration.sql (loaded in runMigrations). The proposals table
-- carries model_call_ids_json here (executable fresh-DB definition mirroring
-- classification-migration.sql); the guarded model_calls_schema_version
-- migration adds the column to old-shape upgrade DBs that lack it.
CREATE TABLE IF NOT EXISTS classification_proposals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES classification_runs(id) ON DELETE CASCADE,
  product_sku TEXT NOT NULL,
  proposal_type TEXT NOT NULL CHECK (proposal_type IN ('primary_product_type', 'category_page', 'field_assignment', 'configuration_gap', 'reviewable_abstention')),
  target_id TEXT,
  proposed_value_json TEXT,
  confidence REAL NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'deferred', 'stale')),
  is_bulk_acceptable INTEGER NOT NULL DEFAULT 0 CHECK (is_bulk_acceptable IN (0, 1)),
  is_stale INTEGER NOT NULL DEFAULT 0 CHECK (is_stale IN (0, 1)),
  staleness_reason TEXT,
  config_snapshot_hash TEXT,
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  supporting_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  contradicting_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  model_call_ids_json TEXT,
  derivation_json TEXT,
  created_at TEXT NOT NULL
);

-- Issue #17 work item H: authoritative evidence-role join.
CREATE TABLE IF NOT EXISTS classification_proposal_evidence (
  proposal_id TEXT NOT NULL REFERENCES classification_proposals(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES classification_evidence(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT 'legacy' CHECK (relation IN ('supporting', 'contradicting', 'context', 'legacy')),
  PRIMARY KEY (proposal_id, evidence_id)
);
CREATE INDEX IF NOT EXISTS idx_classification_proposal_evidence_relation ON classification_proposal_evidence(relation);

-- Issue #17 work item I: append-only reviewer-correction citations.
CREATE TABLE IF NOT EXISTS classification_proposal_decision_evidence (
  decision_id TEXT NOT NULL REFERENCES classification_proposal_decisions(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES classification_evidence(id) ON DELETE CASCADE,
  PRIMARY KEY (decision_id, evidence_id)
);
CREATE INDEX IF NOT EXISTS idx_classification_decision_evidence_decision ON classification_proposal_decision_evidence(decision_id);

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

INSERT OR IGNORE INTO app_meta (key, value) VALUES ('schema_version', '1');
INSERT OR IGNORE INTO app_meta (key, value) VALUES ('app_version', '0.1.0');


-- ── Store Manager runtime audit (epic #42, #40) ─────────────────────────────
CREATE TABLE IF NOT EXISTS store_manager_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  thread_id TEXT,
  turn_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  policy_snapshot_json TEXT,
  requested_model TEXT,
  resolved_provider TEXT NOT NULL,
  resolved_model TEXT NOT NULL,
  resolved_locality TEXT NOT NULL CHECK (resolved_locality IN ('local', 'cloud')),
  resolution_reason TEXT NOT NULL,
  model_call_id TEXT,
  objective TEXT,
  entrypoint TEXT,
  execution_mode TEXT,
  actor_class TEXT,
  scope_json TEXT,
  scope_hash TEXT,
  prompt_version TEXT,
  lineage_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'terminal')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_store_manager_sessions_ws ON store_manager_sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_store_manager_sessions_thread ON store_manager_sessions(thread_id);
CREATE INDEX IF NOT EXISTS idx_store_manager_sessions_model_call ON store_manager_sessions(model_call_id);
CREATE INDEX IF NOT EXISTS idx_store_manager_sessions_entrypoint ON store_manager_sessions(workspace_id, entrypoint);

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
  sequence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_store_manager_events_ws ON store_manager_events(workspace_id);
CREATE INDEX IF NOT EXISTS idx_store_manager_events_session ON store_manager_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_store_manager_events_sequence ON store_manager_events(workspace_id, sequence);

-- Operations-console run artifacts (epic: operations console, Issue 1):
-- immutable, content-addressed, bounded by the artifacts runtime module.
CREATE TABLE IF NOT EXISTS store_manager_run_artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_store_manager_run_artifacts_ws_run ON store_manager_run_artifacts(workspace_id, run_id, created_at);

-- Operations-console schedules (epic: operations console, Issue 4):
-- workspace-owned leased read-only run definitions, immutable versions,
-- restart-safe occurrences (unique per-workspace occurrence key), and leases.
CREATE TABLE IF NOT EXISTS store_manager_schedules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  template_kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  timezone TEXT NOT NULL,
  recurrence_preset TEXT NOT NULL,
  time_of_day TEXT NOT NULL,
  day_of_week INTEGER,
  scope_json TEXT,
  selected_model TEXT,
  objective TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  policy_profile_json TEXT,
  next_run_at TEXT,
  last_run_at TEXT,
  last_run_status TEXT,
  last_run_id TEXT,
  enable_audit_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_store_manager_schedules_ws_enabled ON store_manager_schedules(workspace_id, enabled);
CREATE TABLE IF NOT EXISTS store_manager_schedule_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, schedule_id, version)
);
CREATE INDEX IF NOT EXISTS idx_store_manager_schedule_versions_sched ON store_manager_schedule_versions(workspace_id, schedule_id, version);
CREATE TABLE IF NOT EXISTS store_manager_schedule_occurrences (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  schedule_version INTEGER NOT NULL,
  occurrence_key TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  run_id TEXT,
  error_code TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, occurrence_key)
);
CREATE INDEX IF NOT EXISTS idx_store_manager_occurrences_due ON store_manager_schedule_occurrences(workspace_id, status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_store_manager_occurrences_sched ON store_manager_schedule_occurrences(workspace_id, schedule_id, scheduled_at);
CREATE TABLE IF NOT EXISTS store_manager_schedule_leases (
  occurrence_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_store_manager_leases_expiry ON store_manager_schedule_leases(workspace_id, lease_expires_at);

