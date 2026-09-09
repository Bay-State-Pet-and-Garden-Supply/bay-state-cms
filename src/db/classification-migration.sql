-- Classification Migration (Phase 1)
-- Adds configuration cache tables for workspace-versioned store/classification/ data,
-- and operational/audit tables for reproducible classification runs and reviewable proposals.
-- Uses CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS for idempotence.

-- ════════════════════════════════════════════════════════════════════════════════
-- Configuration Cache / Snapshot Tables
-- ════════════════════════════════════════════════════════════════════════════════

-- Tracks individual config files from store/classification/ per workspace.
-- workspace_id references workspace(id).
CREATE TABLE IF NOT EXISTS classification_config_files (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  file_name TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT NOT NULL,
  content_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, file_name)
);

-- Point-in-time snapshots of the entire classification config used for a run.
CREATE TABLE IF NOT EXISTS classification_config_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  manifest_schema_version INTEGER,
  compatibility_version INTEGER,
  source_commit TEXT,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, snapshot_hash)
);

-- Cached product type config entries.
CREATE TABLE IF NOT EXISTS classification_product_types (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  attribute_profile_id TEXT,
  old_id_aliases_json TEXT DEFAULT '[]',
  config_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

-- Cached product attribute config entries.
CREATE TABLE IF NOT EXISTS classification_attributes (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  value_mode TEXT NOT NULL CHECK (value_mode IN ('controlled', 'freeText', 'measured')),
  canonical_unit TEXT,
  allowed_values_json TEXT DEFAULT '[]',
  value_aliases_json TEXT DEFAULT '[]',
  visual_evidence_eligibility TEXT NOT NULL DEFAULT 'eligible' CHECK (visual_evidence_eligibility IN ('eligible', 'ineligible')),
  is_claim INTEGER NOT NULL DEFAULT 0 CHECK (is_claim IN (0, 1)),
  is_composition_attribute INTEGER NOT NULL DEFAULT 0 CHECK (is_composition_attribute IN (0, 1)),
  group_name TEXT,
  config_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

-- Cached attribute profile config entries.
CREATE TABLE IF NOT EXISTS classification_attribute_profiles (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  product_type_id TEXT NOT NULL,
  name TEXT NOT NULL,
  attributes_json TEXT NOT NULL DEFAULT '[]',
  config_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

-- Cached attribute mapping config entries.
CREATE TABLE IF NOT EXISTS classification_attribute_mappings (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  attribute_id TEXT NOT NULL,
  catalog_field TEXT NOT NULL,
  serialization_json TEXT NOT NULL DEFAULT '{}',
  is_stale INTEGER NOT NULL DEFAULT 0 CHECK (is_stale IN (0, 1)),
  config_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

-- Cached brand config entries for deterministic brand resolution.
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

CREATE INDEX IF NOT EXISTS idx_classification_brands_workspace
  ON classification_brands(workspace_id);

-- Cached catalog manager guidance entries.
CREATE TABLE IF NOT EXISTS classification_guidance (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('workspace', 'productType', 'attribute', 'categoryPage', 'attributeMapping')),
  scope_id TEXT,
  structured_json TEXT NOT NULL DEFAULT '{}',
  free_form TEXT,
  manual_review_requirement INTEGER NOT NULL DEFAULT 0 CHECK (manual_review_requirement IN (0, 1)),
  config_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

-- Model policy (one row per workspace).
CREATE TABLE IF NOT EXISTS classification_model_policies (
  workspace_id TEXT PRIMARY KEY,
  policy_json TEXT NOT NULL DEFAULT '{}',
  config_hash TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

-- Data sharing policy (one row per workspace).
CREATE TABLE IF NOT EXISTS classification_data_sharing_policies (
  workspace_id TEXT PRIMARY KEY,
  policy_json TEXT NOT NULL DEFAULT '{}',
  config_hash TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

-- ════════════════════════════════════════════════════════════════════════════════
-- Operational / Audit Tables
-- ════════════════════════════════════════════════════════════════════════════════

-- A classification run for one product SKU.
CREATE TABLE IF NOT EXISTS classification_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  onboarding_item_id TEXT REFERENCES onboarding_items(id) ON DELETE SET NULL,
  source_kind TEXT NOT NULL DEFAULT 'onboarding' CHECK (source_kind IN ('onboarding', 'catalog_product')),
  source_product_hash TEXT,
  product_sku TEXT NOT NULL,
  config_snapshot_id TEXT REFERENCES classification_config_snapshots(id),
  config_snapshot_hash TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'completed_with_abstentions', 'failed', 'cancelled')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT
);

-- Result of one stage within a classification run.
CREATE TABLE IF NOT EXISTS classification_stage_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES classification_runs(id) ON DELETE CASCADE,
  stage_name TEXT NOT NULL CHECK (stage_name IN ('packaging_ocr', 'evidence_extraction', 'name_consolidation', 'primary_product_type_proposal', 'attribute_applicability', 'product_attribute_proposals', 'category_page_proposals', 'product_draft_projection')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'abstained')),
  output_json TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

-- Evidence collected during a classification run.
CREATE TABLE IF NOT EXISTS classification_evidence (
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

-- Proposals produced by a classification run.
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

-- Join table linking proposals to evidence.
CREATE TABLE IF NOT EXISTS classification_proposal_evidence (
  proposal_id TEXT NOT NULL REFERENCES classification_proposals(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES classification_evidence(id) ON DELETE CASCADE,
  -- Issue #17 work item H: the join is authoritative for evidence roles.
  -- 'legacy' marks rows written before relations existed (run-wide unions).
  relation TEXT NOT NULL DEFAULT 'legacy' CHECK (relation IN ('supporting', 'contradicting', 'context', 'legacy')),
  PRIMARY KEY (proposal_id, evidence_id)
);

-- Reviewer decisions on proposals.
CREATE TABLE IF NOT EXISTS classification_proposal_decisions (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES classification_proposals(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected', 'deferred')),
  revised_from_id TEXT REFERENCES classification_proposal_decisions(id),
  reviewer_id TEXT,
  reviewer_note TEXT,
  revised_value_json TEXT,
  revised_target_id TEXT,
  has_revised_target INTEGER NOT NULL DEFAULT 0,
  decision_key TEXT,
  superseded_at TEXT,
  created_at TEXT NOT NULL
);

-- Issue #17 work item I: append-only evidence citations per reviewer decision.
-- FKs cascade with the decision/evidence rows; deterministic order is applied
-- by the writer (sorted, deduplicated). A cited evidence id must belong to the
-- same run/SKU and be linked to the decision's proposal in one of the H
-- relations (validated by the review service before any row is written).
CREATE TABLE IF NOT EXISTS classification_proposal_decision_evidence (
  decision_id TEXT NOT NULL REFERENCES classification_proposal_decisions(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES classification_evidence(id) ON DELETE CASCADE,
  PRIMARY KEY (decision_id, evidence_id)
);

-- Operational history / audit events.
CREATE TABLE IF NOT EXISTS classification_history_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  product_sku TEXT NOT NULL,
  run_id TEXT,
  proposal_id TEXT,
  decision_id TEXT,
  event_type TEXT NOT NULL,
  event_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

-- Refresh queue for config-change-driven classification reruns.
CREATE TABLE IF NOT EXISTS classification_refresh_queue (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  product_sku TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  refresh_scope_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  requested_by TEXT,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  error_message TEXT
);

-- Deferrals from refresh queue.
CREATE TABLE IF NOT EXISTS classification_refresh_deferrals (
  id TEXT PRIMARY KEY,
  refresh_queue_id TEXT NOT NULL REFERENCES classification_refresh_queue(id) ON DELETE CASCADE,
  product_sku TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

-- ════════════════════════════════════════════════════════════════════════════════
-- Model-call provenance (issue #17 work item E)
--
-- One row per protected model call that can affect a classification run. The
-- row is inserted as `started` BEFORE transport and updated to a terminal
-- status on every path. Only hashes of prompts are stored — never prompt
-- bodies, credentials, or remote response bodies. Legacy `curation_model_calls`
-- is DEPRECATED and intentionally untouched; new provenance lives here.
-- ════════════════════════════════════════════════════════════════════════════════
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

-- ════════════════════════════════════════════════════════════════════════════════
-- Curation Orchestration Tables (Phase 8A — Batch Orchestration)
-- Provider-agnostic; provider IDs are stored in JSON metadata, not dedicated columns.
-- ════════════════════════════════════════════════════════════════════════════════

-- Batch-level curation run for a set of onboarding items.
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

-- Individual item within a curation run.
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

-- Product-line group within a curation run.
CREATE TABLE IF NOT EXISTS curation_run_groups (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES curation_runs(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  group_label TEXT NOT NULL,
  skus_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

-- Provider-agnostic model call tracking.
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

-- ════════════════════════════════════════════════════════════════════════════════
-- Indexes
-- ════════════════════════════════════════════════════════════════════════════════

-- Config cache indexes
CREATE INDEX IF NOT EXISTS idx_classification_config_files_workspace
  ON classification_config_files(workspace_id);

CREATE INDEX IF NOT EXISTS idx_classification_config_snapshots_workspace
  ON classification_config_snapshots(workspace_id);

CREATE INDEX IF NOT EXISTS idx_classification_product_types_workspace
  ON classification_product_types(workspace_id);

CREATE INDEX IF NOT EXISTS idx_classification_attributes_workspace
  ON classification_attributes(workspace_id);

CREATE INDEX IF NOT EXISTS idx_classification_attribute_profiles_workspace
  ON classification_attribute_profiles(workspace_id);

CREATE INDEX IF NOT EXISTS idx_classification_attribute_mappings_workspace
  ON classification_attribute_mappings(workspace_id);

CREATE INDEX IF NOT EXISTS idx_classification_guidance_workspace
  ON classification_guidance(workspace_id);

-- Runs indexes
CREATE INDEX IF NOT EXISTS idx_classification_runs_workspace_sku
  ON classification_runs(workspace_id, product_sku);

CREATE INDEX IF NOT EXISTS idx_classification_runs_status
  ON classification_runs(status);

CREATE INDEX IF NOT EXISTS idx_classification_runs_workspace
  ON classification_runs(workspace_id);

-- Prevent concurrent catalog classification runs for the same product
CREATE UNIQUE INDEX IF NOT EXISTS idx_classification_runs_one_running_catalog
  ON classification_runs(workspace_id, product_sku)
  WHERE source_kind = 'catalog_product' AND status = 'running';

CREATE INDEX IF NOT EXISTS idx_classification_runs_workspace_sku_source_time
  ON classification_runs(workspace_id, product_sku, source_kind, started_at DESC);

-- Stage results indexes
CREATE INDEX IF NOT EXISTS idx_classification_stage_results_run
  ON classification_stage_results(run_id);

-- Evidence indexes
CREATE INDEX IF NOT EXISTS idx_classification_evidence_run
  ON classification_evidence(run_id);

CREATE INDEX IF NOT EXISTS idx_classification_evidence_product_source
  ON classification_evidence(product_sku, source);

CREATE INDEX IF NOT EXISTS idx_classification_evidence_product
  ON classification_evidence(product_sku);

-- Proposals indexes
CREATE INDEX IF NOT EXISTS idx_classification_proposals_run
  ON classification_proposals(run_id);

CREATE INDEX IF NOT EXISTS idx_classification_proposals_product_status
  ON classification_proposals(product_sku, status);

CREATE INDEX IF NOT EXISTS idx_classification_proposals_product
  ON classification_proposals(product_sku);

-- Decisions index
CREATE INDEX IF NOT EXISTS idx_classification_proposal_decisions_proposal
  ON classification_proposal_decisions(proposal_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_classification_decisions_key
  ON classification_proposal_decisions(decision_key)
  WHERE decision_key IS NOT NULL;

-- History indexes
CREATE INDEX IF NOT EXISTS idx_classification_history_workspace_product
  ON classification_history_events(workspace_id, product_sku);

CREATE INDEX IF NOT EXISTS idx_classification_history_product
  ON classification_history_events(product_sku);

-- Refresh queue indexes
CREATE INDEX IF NOT EXISTS idx_classification_refresh_queue_workspace_status
  ON classification_refresh_queue(workspace_id, status);

CREATE INDEX IF NOT EXISTS idx_classification_refresh_queue_status
  ON classification_refresh_queue(status);

-- Model-call provenance indexes
CREATE INDEX IF NOT EXISTS idx_classification_model_calls_run
  ON classification_model_calls(run_id);

CREATE INDEX IF NOT EXISTS idx_classification_model_calls_snapshot
  ON classification_model_calls(snapshot_hash);

-- Curation orchestration indexes
CREATE INDEX IF NOT EXISTS idx_curation_runs_workspace
  ON curation_runs(workspace_id);

CREATE INDEX IF NOT EXISTS idx_curation_runs_status
  ON curation_runs(status);

CREATE INDEX IF NOT EXISTS idx_curation_run_items_run
  ON curation_run_items(run_id);

CREATE INDEX IF NOT EXISTS idx_curation_run_items_status
  ON curation_run_items(status);

CREATE INDEX IF NOT EXISTS idx_curation_run_items_sku
  ON curation_run_items(sku);

CREATE INDEX IF NOT EXISTS idx_curation_run_groups_run
  ON curation_run_groups(run_id);

CREATE INDEX IF NOT EXISTS idx_curation_model_calls_run
  ON curation_model_calls(run_id);
